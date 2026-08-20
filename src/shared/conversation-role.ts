/**
 * WHAT A CONVERSATION IS -- one derived role, so the panel stops guessing.
 *
 * "What kind of thing is this row" used to be re-derived at render time from
 * four unrelated sources: a URI shape for worktrees, a capability STRING for
 * ad-hoc, an epic tag nothing read, and a nightshift tag nothing read. The
 * if-chain that did it lived in the sidebar, and the same
 * `capabilities.includes('ad-hoc')` lookup was copy-pasted across seven files.
 *
 * THIS FIELD IS PRESENTATION. IT NEVER GATES AUTHORITY.
 * The same law `protocol.ts` already writes for the `epic` tag applies here
 * verbatim: it is an origin tag surfaces GROUP and DRAW on, never a capability.
 * What a role actually BUYS -- the mute, merge authority, whether it may ask a
 * human -- is enforced by the settings the spawn carried and by
 * `mayAskHuman()`. Nothing may read this value to decide what an agent MAY DO.
 * `if (role === 'overseer') allow…` is the bug this paragraph exists to prevent.
 *
 * IT IS DERIVED, NEVER STORED. The origin tags stay authoritative; this is a
 * pure function of them. A persisted copy would drift from the tag that
 * produced it, and drift in a provenance field is worse than no field.
 *
 * ROLE IS ONE AXIS OF THREE, and they do not collapse:
 *   role       WHAT IT IS      -> icon, tint, sort rank        (this file)
 *   ad-hoc     HOW IT ENDS     -> self-terminating, task-bound (capability)
 *   worktree   WHERE IT RUNS   -> URI shape
 * An epic implementer is all three at once. Folding them into one enum makes
 * "implementer, ad-hoc, in a worktree" unrepresentable -- which is exactly the
 * row this codebase runs most often.
 */

/**
 * The seats a conversation can occupy, widest first in visual precedence.
 *
 * This is `EpicRole` widened by one member, NOT a second vocabulary --
 * `epic-run-types.ts` re-derives `EpicRole` from this type so the three shared
 * names can never drift apart. `implementer` is deliberately NOT called
 * `worker`: in `epic-worker-permissions.ts` a "worker" is ANY non-overseer seat
 * (implementer AND verifier both), and one word meaning two sizes of thing in
 * two files is how vocabulary rots.
 */
export type ConversationRole = 'normal' | 'implementer' | 'verifier' | 'overseer'

/** Rank for sorting: LOWER sorts first. An overseer heads its project group;
 *  its seats follow; everything else is ordinary. Consumers sort on this rather
 *  than re-listing the enum, so adding a role cannot silently sort last. */
export const CONVERSATION_ROLE_RANK: Record<ConversationRole, number> = {
  overseer: 0,
  implementer: 1,
  verifier: 2,
  normal: 3,
}

/**
 * The origin tags this classifier reads. Structural on purpose: taking
 * `EpicLaunchTag` directly would make `epic-run-types.ts` -> this file -> back
 * again, and this file must stay the leaf so anything can import it.
 */
export interface ConversationRoleSource {
  /** EPIC MODE seat tag, broker-authored at dispatch. */
  epic?: { role: ConversationRole }
}

/**
 * Derive the role from whatever origin tags a conversation carries.
 *
 * NIGHTSHIFT IS DELIBERATELY NOT A ROLE. A night task is an ordinary
 * conversation running on a schedule -- it holds no seat in a supervised run,
 * has no overseer above it, and nothing nests under it. Giving it a role member
 * would put a CADENCE on the same axis as a SEAT, which is the collapse this
 * file exists to prevent. If night rows ever need their own glyph, that is a
 * fourth axis, not a fifth role.
 */
export function classifyConversationRole(source: ConversationRoleSource): ConversationRole {
  return source.epic?.role ?? 'normal'
}

/**
 * The key that decides which overseer a seat nests under, or `null` for a row
 * that nests under nobody.
 *
 * WHY A FUNCTION AND NOT JUST `epicId`. The agreed design is one overseer per
 * PROJECT serving several epics. The engine does not do that yet -- it leases
 * one overseer per EPIC CARD (`epic-beat-actions.ts`, `op: 'lease'` keyed on
 * `epicId`), and two epic cards in one project each hold their own lease slot.
 * So the sidebar groups on whatever this returns: today the epicId, and the day
 * the lease becomes a project singleton, the project URI. Neither the grouping
 * code nor its tests change when that happens.
 *
 * LINEAGE IS THE WRONG KEY and was rejected deliberately: it roots at a
 * CONVERSATION, and overseer generations rotate. Seats rooted at generation 32
 * would hang under a dead row the moment generation 33 took the lease.
 */
export function overseerScopeKey(source: ConversationRoleSource & { epic?: { epicId?: string } }): string | null {
  return source.epic?.epicId ?? null
}

/** Does this role occupy a seat in a supervised run? True for everything that
 *  belongs INSIDE an overseer's subtree, including the overseer heading it. */
export function isEpicSeatRole(role: ConversationRole): boolean {
  return role !== 'normal'
}
