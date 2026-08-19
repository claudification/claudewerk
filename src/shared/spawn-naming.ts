/**
 * Derive a human-readable session label from spawn request hints.
 *
 * Order of preference:
 *   1. explicit `req.name`
 *   2. `task.title`
 *   3. first non-empty line of `req.prompt`
 *
 * Returns `null` when no hint is available -- callers should fall back to
 * the random generator in `./session-names`.
 */

import type { TaskMeta } from './spawn-prompt'
import type { SpawnRequest } from './spawn-schema'

const MAX_NAME_LEN = 60

/**
 * Ordered rules. Fences and links before emphasis, emphasis before the bare
 * backtick, so an inner marker is never orphaned by an outer one being removed
 * first. Mirrors `body-preview.ts` -- same job, one line instead of six.
 */
const STRIP: Array<[RegExp, string]> = [
  // Control characters, including the newlines a pasted title arrives with.
  [/[\u0000-\u001f\u007f-\u009f]/g, ' '],
  // Fenced code and its lonely delimiters -- `ANVIL @code block (the ~~~ ...)`.
  [/```|~~~/g, ' '],
  // Images before links: `![alt](src)` is a link shape wearing a `!`.
  [/!\[[^\]]*\]\([^)]*\)/g, ' '],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  // Leading markdown line markers -- a title pasted off a heading keeps the `#`.
  [/^[ \t]*#{1,6}[ \t]+/, ''],
  [/^[ \t]*>[ \t]?/, ''],
  [/^[ \t]*[-*+][ \t]+/, ''],
  // Emphasis. Paired only, so `2 * 3` and `snake_case` survive.
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/__([^_]+)__/g, '$1'],
  [/\*([^\s*][^*]*)\*/g, '$1'],
  // Inline code: keep what is inside. `--agent <name>` should read as one.
  [/`([^`]+)`/g, '$1'],
  [/`/g, ''],
  // Angle brackets: keep the word, drop the brackets that read as a tag.
  [/<([^<>]*)>/g, '$1'],
  // Quotes, anywhere. YAML forces them onto every title holding a colon.
  [/['"]/g, ''],
]

/**
 * Punctuation that is noise on an end but content in the middle.
 *
 * CLOSERS ARE NOT JUNK. An earlier version had `)` in the trailing class and
 * turned `feat: ... (no tmux)` into `... (no tmux` and `reload the SW :-)` into
 * `reload the SW` -- it ate the end of the title to tidy it. Same for `?` and
 * `!`, which are how a question-shaped card ends.
 */
const EDGE_JUNK = /^[\s\-–—*_.,:;|/\\]+|[\s\-–—*_,:;|/\\([{<]+$/g

/**
 * A raw title as a conversation name that is safe to display and route.
 *
 * This used to be quotes-and-whitespace only, which is not sanitizing so much
 * as hoping. Card titles are markdown and arrive as written: `add ... support
 * for \`--agent <name>\``, `ANVIL @code block (the ~~~ literal delimiter)`,
 * `**A**gent-**N**ative`. Launching those put the raw syntax in the
 * conversation list.
 *
 * It strips SYNTAX and keeps CONTENT. Colons, parens, slashes, `@` and `+` all
 * survive on purpose -- `feat: agent direct-spawns` and `EPIC: ...` are how
 * these cards are actually titled, and nothing downstream treats a name as a
 * path (the address book folds its own slug via `slugifyAddressPart`).
 */
export function sanitizeConversationName(raw: string): string {
  let text = raw
  for (const [pattern, replacement] of STRIP) text = text.replace(pattern, replacement)
  return text.replace(/\s+/g, ' ').replace(EDGE_JUNK, '').slice(0, MAX_NAME_LEN).replace(EDGE_JUNK, '')
}

/** Validate an explicit session name. Returns an error string or null if valid. */
export function validateConversationName(name: string, existingNames: Set<string>): string | null {
  const sanitized = sanitizeConversationName(name)
  if (!sanitized) return 'Session name is empty after sanitization'
  if (existingNames.has(sanitized)) return `Session name "${sanitized}" is already in use`
  return null
}

/**
 * The same name, made free -- for a caller that would rather be renamed than
 * refused (`failOnNameCollision: false`).
 *
 * WHY THIS EXISTS. Uniqueness is checked against every conversation that has
 * EVER existed, ended ones included, and the check is a hard 400. That is right
 * for a human at the launch dialog, who would otherwise end up with two
 * identical rows in the sidebar. It is wrong for a machine: an unattended engine
 * dispatching the same card a second time after a bounce produces the same name
 * by construction, and the refusal makes retry structurally impossible. Live on
 * 2026-08-19 an epic run logged `Session name "..." is already in use` every 45
 * seconds and never progressed.
 *
 * The suffix is ` (2)`, ` (3)` ... and the STEM is trimmed to make room, because
 * a name is truncated from the right -- appending past the budget would slice the
 * disambiguator straight back off and return a name that still collides.
 */
export function uniqueConversationName(name: string, existingNames: Set<string>): string {
  const stem = sanitizeConversationName(name)
  if (!stem) return stem
  if (!existingNames.has(stem)) return stem
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`
    const candidate = `${stem.slice(0, MAX_NAME_LEN - suffix.length).trimEnd()}${suffix}`
    if (!existingNames.has(candidate)) return candidate
  }
  // A thousand conversations sharing one name is not a case to paper over.
  return stem
}

export function deriveConversationName(req: Partial<SpawnRequest>, task?: TaskMeta): string | null {
  if (req.name) {
    const n = sanitizeConversationName(req.name)
    if (n) return n
  }
  if (task?.title) {
    const n = sanitizeConversationName(task.title)
    if (n) return n
  }
  if (req.prompt) {
    const firstLine = req.prompt.split('\n').find(l => l.trim().length > 0)
    if (firstLine) {
      const n = sanitizeConversationName(firstLine)
      if (n) return n
    }
  }
  return null
}
