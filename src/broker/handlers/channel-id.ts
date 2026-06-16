/**
 * Pure ID-formatting + send-resolver helpers for channel.ts.
 *
 * Extracted so they can be unit-tested without spinning up the full handler
 * context (sessions store, address book, sockets, etc).
 *
 * Stable-ID rule (the whole point of this file):
 *   - `list_conversations` ALWAYS returns compound `project:conversation-slug` ids.
 *   - The bare `project` form is NEVER produced. This guarantees the id a
 *     caller sees today does not silently change shape tomorrow when a
 *     second conversation spawns at the same project.
 *
 * Resolver rule (what `send_message` accepts as `to`):
 *   - Compound `project:conversation-slug` -> resolves directly inside the project
 *   - Bare `project`                        -> accepted ONLY when exactly one
 *                                              candidate conversation exists at
 *                                              the project; rejected as ambiguous
 *                                              when 2+.
 */

import { extractProjectLabel, isSameProject } from '../../shared/project-uri'
import { slugify } from '../address-book'
import { isAliasLive } from '../former-slugs'
import type { FormerSlug } from '../store/types'

export interface ConversationLike {
  id: string
  project: string
  title?: string
  /** Retired addressable slugs with decay bookkeeping (rename-alias retention). */
  formerSlugs?: FormerSlug[]
}

/**
 * Compute the per-conversation slug suffix used inside compound ids.
 * Falls back to a 6-char id slice when two conversations in the same project would
 * slug to the same value (so siblings stay disambiguable).
 */
export function computeConversationSlug(
  target: ConversationLike,
  siblingConversations: ConversationLike[],
  now: number = Date.now(),
): string {
  const conversationSlug = slugify(target.title || target.id.slice(0, 8))
  // A name collides if a sibling CURRENTLY answers to it OR still holds it as an
  // in-window former slug (rename-alias retention) -- otherwise a fresh/renamed
  // conversation could grab a name that is still forwarding to someone else.
  const collides = siblingConversations.some(other => {
    if (other.id === target.id) return false
    if (slugify(other.title || other.id.slice(0, 8)) === conversationSlug) return true
    return (other.formerSlugs ?? []).some(f => f.slug === conversationSlug && isAliasLive(f, now))
  })
  return collides ? `${conversationSlug}-${target.id.slice(0, 6)}` : conversationSlug
}

/**
 * Always-compound local id: `project:conversation-slug`.
 *
 * Use for both `list_conversations` output and the from-id stamped on outgoing
 * messages so a recipient can replay it verbatim as `to`.
 */
export function computeLocalId(
  target: ConversationLike,
  projectSlug: string,
  siblingConversations: ConversationLike[],
): string {
  return `${projectSlug}:${computeConversationSlug(target, siblingConversations)}`
}

// ─── Send target resolution ─────────────────────────────────────────

export type ResolveSendTarget =
  | { kind: 'resolved'; conversation: ConversationLike; viaAlias?: string }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; canonicalProject: string; candidates: ConversationLike[] }

export interface ResolveSendInput {
  /** The slug to the LEFT of `:` in the wire `to` -- a project slug. */
  projectSlug: string
  /** The slug to the RIGHT of `:`, or undefined for bare addressing. */
  conversationSlug: string | undefined
  /** All sessions registered at the resolved target project (live + inactive). */
  conversationsAtProject: ConversationLike[]
  /** The canonical project slug (label or dirname) to surface in error messages. */
  canonicalProject: string
  /** Predicate -- "is this conversation currently online?". Live count drives ambiguity. */
  isLive: (s: ConversationLike) => boolean
  /** Epoch ms for the in-window check on former-slug aliases. Defaults to Date.now(). */
  now?: number
}

/**
 * Resolve a parsed `(projectSlug, conversationSlug?)` target against the conversations
 * registered at a given project. Returns the chosen conversation, a not-found marker,
 * or an ambiguous-bare error with the candidate compound ids the caller
 * should use instead.
 *
 * Bare-acceptance rule: a bare project address is allowed ONLY when there is
 * a unique candidate (preferring live over inactive). Multiple live conversations
 * = ambiguous. No live + multiple inactive = also ambiguous (caller must
 * pick one explicitly with the compound form).
 */
export function resolveSendTarget(input: ResolveSendInput): ResolveSendTarget {
  const { projectSlug, conversationSlug, conversationsAtProject, isLive } = input
  const now = input.now ?? Date.now()

  if (conversationSlug !== undefined) {
    const exact = conversationsAtProject.find(s => slugify(s.title || s.id.slice(0, 8)) === conversationSlug)
    if (exact) return { kind: 'resolved', conversation: exact }
    const prefix = conversationsAtProject.find(s => slugify(s.title || s.id.slice(0, 8)).startsWith(conversationSlug))
    if (prefix) return { kind: 'resolved', conversation: prefix }
    // Former-slug alias tier (LOWEST priority -- a live current-slug match above
    // always wins). A conversation that shed `conversationSlug` via rename still
    // answers to it for the decay window, so peers that cached the old name keep
    // routing. Two conversations holding the same in-window alias = ambiguous
    // (never a silent guess). On a unique hit, `viaAlias` tells the caller to
    // refresh lastUsedAt + surface the canonical current address.
    const aliasHits = conversationsAtProject.filter(s =>
      (s.formerSlugs ?? []).some(f => f.slug === conversationSlug && isAliasLive(f, now)),
    )
    if (aliasHits.length === 1) return { kind: 'resolved', conversation: aliasHits[0], viaAlias: conversationSlug }
    if (aliasHits.length > 1) {
      return { kind: 'ambiguous', canonicalProject: input.canonicalProject, candidates: aliasHits }
    }
    return { kind: 'not_found' }
  }

  // Bare addressing.
  // First: exact conversation-title match (a conversation named "arr" beats project-level dispatch).
  const titleMatch = conversationsAtProject.find(s => slugify(s.title || s.id.slice(0, 8)) === projectSlug)
  if (titleMatch) return { kind: 'resolved', conversation: titleMatch }

  const live = conversationsAtProject.filter(isLive)
  if (live.length === 1) return { kind: 'resolved', conversation: live[0] }
  if (live.length > 1) {
    return { kind: 'ambiguous', canonicalProject: input.canonicalProject, candidates: live }
  }
  // No live -- fall back to inactive, but only if unambiguous.
  if (conversationsAtProject.length === 1) return { kind: 'resolved', conversation: conversationsAtProject[0] }
  if (conversationsAtProject.length > 1) {
    return { kind: 'ambiguous', canonicalProject: input.canonicalProject, candidates: conversationsAtProject }
  }
  return { kind: 'not_found' }
}

/**
 * Format the user-facing ambiguity error with the compound ids the caller
 * should retry with. Lives here (not in the handler) so it stays in sync
 * with the resolver and is testable without a context.
 */
export function formatAmbiguityError(canonicalProject: string, candidates: ConversationLike[]): string {
  const siblingConversations = candidates
  const ids = candidates.map(s => `${canonicalProject}:${computeConversationSlug(s, siblingConversations)}`).join(', ')
  return `Ambiguous target: ${candidates.length} conversations at "${canonicalProject}". Use compound address: ${ids}`
}

// ─── Cross-project conversation-name fallback ───────────────────────

/**
 * Last-resort resolver: the PROJECT slug (left of `:`) never resolved -- the
 * caller's address-book slug was stale, wrong, or the caller addressed bare by a
 * conversation name that is not a project. The conversation NAME is the stable,
 * user-facing handle (the project slug is volatile per-caller address-book
 * cruft that drifts on rename / re-label), so match `name` against EVERY
 * conversation's current title across ALL projects -- exact first, then prefix,
 * then in-window former-slug aliases. A unique hit routes; 2+ is ambiguous
 * (never a silent guess); none is not_found.
 *
 * Runs ONLY after project-slug resolution has already failed, so it can never
 * hijack a correctly-addressed (but merely offline) target -- it is strictly
 * additive recovery for an otherwise-dead send.
 */
export function resolveByConversationName(
  name: string,
  allConversations: ConversationLike[],
  now: number = Date.now(),
): ResolveSendTarget {
  const slug = slugify(name)
  const titleOf = (s: ConversationLike) => slugify(s.title || s.id.slice(0, 8))

  const decide = (hits: ConversationLike[], viaAlias?: string): ResolveSendTarget | undefined => {
    if (hits.length === 1) return { kind: 'resolved', conversation: hits[0], ...(viaAlias ? { viaAlias } : {}) }
    if (hits.length > 1) return { kind: 'ambiguous', canonicalProject: '*', candidates: hits }
    return undefined
  }

  const exact = decide(allConversations.filter(s => titleOf(s) === slug))
  if (exact) return exact
  const prefix = decide(allConversations.filter(s => titleOf(s).startsWith(slug)))
  if (prefix) return prefix
  const alias = decide(
    allConversations.filter(s => (s.formerSlugs ?? []).some(f => f.slug === slug && isAliasLive(f, now))),
    slug,
  )
  if (alias) return alias
  return { kind: 'not_found' }
}

/**
 * Ambiguity error for the cross-project name fallback. Unlike
 * `formatAmbiguityError` (single project), candidates here span projects, so
 * each suggested id carries its own canonical project slug.
 */
export function formatCrossProjectAmbiguityError(candidates: ConversationLike[]): string {
  const ids = candidates
    .map(c => {
      const projectSlug = slugify(extractProjectLabel(c.project))
      const siblings = candidates.filter(o => isSameProject(o.project, c.project))
      return computeLocalId(c, projectSlug, siblings)
    })
    .join(', ')
  return `Ambiguous conversation name: ${candidates.length} conversations match. Use a compound project:name address: ${ids}`
}

// ─── Shared target resolution ──────────────────────────────────────

export type ResolveConversationResult =
  | { kind: 'resolved'; conversation: ConversationLike; viaAlias?: string }
  | { kind: 'not_found'; error: string }
  | { kind: 'ambiguous'; error: string }

export interface ResolveConversationDeps {
  callerConversationId: string | undefined
  getAllConversations: () => ConversationLike[]
  getConversation: (id: string) => ConversationLike | undefined
  findConversationByConversationId: (id: string) => ConversationLike | undefined
  getActiveConversationCount: (id: string) => number
  getProjectSettings: (project: string) => { label?: string } | null
  addressBook: {
    resolve: (fromProject: string, slug: string) => string | undefined
    getOrAssign: (fromProject: string, toProject: string, name: string) => string
  }
  callerProject: string | undefined
}

/**
 * Resolve a target ID (compound "project:conversation-slug", bare project slug,
 * or raw internal conversation ID) to a conversation.
 *
 * Used by conversation_control, channel_restart, channel_configure, and
 * channel_send to consistently handle the compound ID format returned
 * by list_conversations.
 */
export function resolveConversationTarget(targetId: string, deps: ResolveConversationDeps): ResolveConversationResult {
  const colonIdx = targetId.indexOf(':')
  const hasCompound = colonIdx >= 0
  const projectSlug = hasCompound ? targetId.slice(0, colonIdx) : targetId
  const conversationSlug = hasCompound ? targetId.slice(colonIdx + 1) : undefined

  let targetProject = deps.callerProject ? deps.addressBook.resolve(deps.callerProject, projectSlug) : undefined

  if (!targetProject && deps.callerProject) {
    for (const s of deps.getAllConversations()) {
      if (s.id === deps.callerConversationId) continue
      const projSettings = deps.getProjectSettings(s.project)
      const projectName = projSettings?.label || extractProjectLabel(s.project)
      deps.addressBook.getOrAssign(deps.callerProject, s.project, projectName)
    }
    targetProject = deps.addressBook.resolve(deps.callerProject, projectSlug)
  }

  if (targetProject) {
    const conversationsAtProject = deps.getAllConversations().filter(s => isSameProject(s.project, targetProject))
    const projSettings = deps.getProjectSettings(targetProject)
    const canonicalProject = slugify(projSettings?.label || extractProjectLabel(targetProject))
    const resolved = resolveSendTarget({
      projectSlug,
      conversationSlug,
      conversationsAtProject,
      canonicalProject,
      isLive: s => deps.getActiveConversationCount(s.id) > 0,
    })
    if (resolved.kind === 'ambiguous') {
      return { kind: 'ambiguous', error: formatAmbiguityError(resolved.canonicalProject, resolved.candidates) }
    }
    if (resolved.kind === 'resolved') {
      return { kind: 'resolved', conversation: resolved.conversation, viaAlias: resolved.viaAlias }
    }
    return { kind: 'not_found', error: `Conversation not found at project "${canonicalProject}"` }
  }

  // Fallback: try raw internal ID / conversation ID
  const fallback = deps.findConversationByConversationId(targetId) || deps.getConversation(targetId)
  if (fallback) return { kind: 'resolved', conversation: fallback }

  // Last resort: the project slug never resolved, but the caller may still hold
  // the conversation NAME. Match it across all projects (see
  // resolveByConversationName). This is what makes a stale project slug recover
  // without a prior list_conversations.
  const byName = resolveByConversationName(conversationSlug ?? projectSlug, deps.getAllConversations())
  if (byName.kind === 'resolved')
    return { kind: 'resolved', conversation: byName.conversation, viaAlias: byName.viaAlias }
  if (byName.kind === 'ambiguous')
    return { kind: 'ambiguous', error: formatCrossProjectAmbiguityError(byName.candidates) }
  return { kind: 'not_found', error: 'Target not connected. Use list_conversations to find current sessions.' }
}
