/**
 * THE CONVERSATION ADDRESS -- one way to name a conversation, everywhere.
 *
 *     project-slug:conversation-slug
 *
 * This is not a new convention: it is the one `send_message` / the MCP
 * `list_conversations` already speak (`computeLocalId` in broker/handlers/
 * channel-id.ts, which now formats through here). It was simply never written
 * down in one place, so the desk toolset grew raw `conv_...` ids and the browser
 * grew a fuzzy spoken-title matcher alongside it -- three shapes for one thing.
 *
 * WHY IT LIVES IN `shared/`: broker (matching a status against a watch), the
 * agent host (naming a peer), and the control panel (rendering a pill) must all
 * agree on what "remote-claude:nightshift" means down to the last hyphen. A
 * second copy of these rules is a routing bug waiting to happen.
 *
 * PATTERNS extend the same address with globs, so a subscriber can say "the
 * whole project" without enumerating it:
 *
 *     remote-claude:*        every conversation in that project
 *     remote-claude          same thing -- a bare token is a PROJECT
 *     *:fix-*                anything named fix-* anywhere
 *     *                      everything
 *
 * Deliberately NOT regex. A pattern arrives by voice or from a model, and `.*`
 * typed into a field that silently means "everything" is how a watch on one
 * project ends up narrating the entire fleet. Two metacharacters, both obvious.
 */

/** The one separator between the project half and the conversation half.
 *  Module-private: callers should go through `formatConversationAddress` /
 *  `parseAddressPattern` rather than splitting a string themselves, which is
 *  exactly how a second (wrong) parse rule gets written. */
const ADDRESS_SEPARATOR = ':'

/** Longest a slug half may be -- matches the historical address-book cap, which
 *  is already baked into every compound id in flight. */
const SLUG_MAX = 24

/**
 * Slug a human name into an address half: lowercase, alphanumerics and hyphens.
 *
 * THE canonical slugger for addresses (broker/address-book.ts re-exports it as
 * `slugify`). Any drift here silently un-routes every compound id in the wild,
 * so change it only with a migration.
 */
export function slugifyAddressPart(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, SLUG_MAX) || 'project'
  )
}

/** Join two already-slugged halves into the canonical address. */
export function formatConversationAddress(projectSlug: string, conversationSlug: string): string {
  return `${projectSlug}${ADDRESS_SEPARATOR}${conversationSlug}`
}

/** A parsed pattern: two glob halves, always both present (`*` when omitted). */
export interface AddressPattern {
  /** Glob for the project half. */
  project: string
  /** Glob for the conversation half. */
  conversation: string
}

/** Slug characters plus the two metacharacters. Anything else (a colon inside a
 *  half, whitespace that did not fold, punctuation from a transcription) is
 *  rejected rather than stripped -- a silently-widened pattern is worse than a
 *  refused one. */
const PATTERN_HALF = /^[a-z0-9*?-]+$/

/** Fold the input the way a slug would, WITHOUT eating the metacharacters:
 *  spaces and underscores become hyphens so a spoken "remote claude" lands on
 *  `remote-claude`.
 *
 *  A DOT IS NOT FOLDED, on purpose. `slugifyAddressPart` turns dots into
 *  hyphens, so folding here would be the friendlier rule -- but it also turns
 *  the regex `.*` into `-*` into `*`, i.e. a model that reaches for regex out of
 *  habit silently subscribes to the entire fleet. Dots fall through to
 *  PATTERN_HALF and the pattern is REFUSED, so the caller re-says it as `v1-2`.
 *  A tax on one honest pattern beats a silent fleet-wide watch. */
function foldHalf(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Parse a pattern into its two halves, or null when it is not a usable pattern.
 *
 * Splits on the FIRST colon, the same rule `resolveConversationTarget` uses, so
 * a pattern and a send target never disagree about where the project half ends.
 * An empty half means "any": `remote-claude:` and `remote-claude` are both the
 * whole project.
 */
export function parseAddressPattern(raw: string): AddressPattern | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null

  const colon = text.indexOf(ADDRESS_SEPARATOR)
  const projectRaw = colon >= 0 ? text.slice(0, colon) : text
  const conversationRaw = colon >= 0 ? text.slice(colon + 1) : '*'

  const project = foldHalf(projectRaw) || '*'
  const conversation = foldHalf(conversationRaw) || '*'
  if (!PATTERN_HALF.test(project) || !PATTERN_HALF.test(conversation)) return null
  return { project, conversation }
}

/** The canonical text form of a pattern -- what gets stored and echoed back, so
 *  a user who said "remote claude" sees `remote-claude:*` in the watch list. */
export function normalizeAddressPattern(raw: string): string | null {
  const parsed = parseAddressPattern(raw)
  return parsed && formatConversationAddress(parsed.project, parsed.conversation)
}

/** True when a pattern matches EVERYTHING -- callers warn on it rather than
 *  quietly subscribing someone to the whole fleet. */
export function isWildcardPattern(pattern: AddressPattern): boolean {
  return pattern.project === '*' && pattern.conversation === '*'
}

/** Compile one glob half. `*` spans any run (including empty), `?` is exactly
 *  one character; everything else is literal. */
function halfMatcher(glob: string): RegExp {
  const body = [...glob]
    .map(ch => {
      if (ch === '*') return '.*'
      if (ch === '?') return '.'
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${body}$`)
}

/** Does `address` (a canonical `project:conversation`) satisfy `pattern`? */
export function matchesAddressPattern(pattern: AddressPattern, address: string): boolean {
  const colon = address.indexOf(ADDRESS_SEPARATOR)
  if (colon < 0) return false
  const project = address.slice(0, colon).toLowerCase()
  const conversation = address.slice(colon + 1).toLowerCase()
  return halfMatcher(pattern.project).test(project) && halfMatcher(pattern.conversation).test(conversation)
}

/** Convenience: does any pattern in the list match? Patterns that fail to parse
 *  are ignored (they can never match, and throwing here would take down a
 *  broadcast for one bad subscription). */
export function matchesAnyPattern(patterns: readonly string[], address: string): boolean {
  return patterns.some(raw => {
    const parsed = parseAddressPattern(raw)
    return parsed !== null && matchesAddressPattern(parsed, address)
  })
}
