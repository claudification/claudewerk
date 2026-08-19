/**
 * WHO WINS a conversation title, in one place.
 *
 * A title has four writers and they do not agree:
 *
 *   user        -- a human renaming from the control panel, or `/rename` typed
 *                  inside CC. Authoritative, and DATED with a real clock.
 *   agent       -- an agent renaming itself (or, benevolent, another). Same
 *                  authority as a human; the human asked for it either way.
 *   cc-auto     -- the launch name CC was started with (`conversation_name`).
 *   cc-observed -- CC's own copy, read off its `custom-title` JSONL control
 *                  line. UNDATED by construction (the line is literally
 *                  `{type,customTitle,sessionId}` and nothing else).
 *
 * Before this module the winner was decided by ARRIVAL ORDER plus one boolean
 * (`titleUserSet`), which is why a replay could time-travel a rename away: every
 * resync re-sends the transcript, and a stale value that arrives late is
 * indistinguishable from a fresh one when order is all you have. Gating on
 * `isInitial` was tried and does not work -- `sendTranscriptEntriesChunked`
 * marks only the FIRST chunk, so a replayed entry in any later chunk looks live
 * (2026-07-28, commit 1afa4954).
 *
 * The fix is to stop asking "is this a replay" and ask "is this NEWER" instead.
 * `/rename` inside CC produces a transcript entry carrying CC's own timestamp,
 * so a replayed rename is self-evidently old and loses on arithmetic. No replay
 * bit is consulted anywhere in this file, and that is the point.
 *
 * `cc-observed` has no timestamp, so it cannot join that comparison at all --
 * it is held back by ORIGIN instead, and only ever SEEDS a title, never changes
 * one. Measured before deciding that: every `custom-title` value written across
 * this fleet since 2026-06-15 is either a slug WE generated or a name the
 * spawn request supplied. CC echoes back the title we gave it; it does not
 * author one. So the line mirrors our own state rather than sourcing it, and
 * the only case where it carries something we do not already know is a session
 * adopted from outside claudewerk (import / attach) -- which is exactly the
 * "nothing set yet" case it is still allowed to fill.
 */

/** Who wrote a title. The first two are authoritative; the last two are CC's. */
export type TitleOrigin = 'user' | 'agent' | 'cc-auto' | 'cc-observed'

const USER_AUTHORED: ReadonlySet<TitleOrigin> = new Set<TitleOrigin>(['user', 'agent'])

/** The title fields of a conversation. Structural so tests need no full Conversation. */
export interface TitleState {
  title?: string
  titleUserSet?: boolean
  titleOrigin?: TitleOrigin
  titleSetAt?: number
  /**
   * Did anybody MEAN this name?
   *
   * `true` -- nobody chose it: a generated petname, or the automatic renamer's
   * own output. Fair game to replace.
   * `false` -- an INTENTIONAL name: a human, `rename_conversation`,
   * `control_conversation`, or a spawn request that supplied one. Never
   * overwritten.
   *
   * Set explicitly on every write from the writer's origin, so it is a recorded
   * fact rather than something re-derived (and re-derived wrongly) later.
   */
  titleEphemeral?: boolean
}

/** One attempt to set a title. `title: undefined` clears it back to the auto name.
 *  `at` is the writer's own clock in ms -- omit it when the source carries none. */
export interface TitleWrite {
  title: string | undefined
  origin: TitleOrigin
  at?: number
}

export type TitleVerdict =
  | { accept: true; at: number | undefined; clamped: boolean }
  | { accept: false; reason: 'unchanged' | 'pinned' | 'stale' }

/**
 * A name NOBODY CHOSE -- the only thing the automatic renamer may replace.
 *
 * This is the question flipped on purpose. Asking "was this set by a user"
 * meant trusting `titleUserSet`, and 1194 live conversations proved that
 * boolean wrong: the legacy spawn path stamped it on its OWN generated petname,
 * so every one of them read as human-authored and was frozen forever
 * (2026-08-19).
 *
 * The answer is ORIGIN, never the text of the name. We already record who wrote
 * a title, so ephemeral is simply "not written by a human or an agent acting for
 * one". Sniffing the string for petname shape would repeat the original
 * mistake in a new costume: the word lists can change, `biome-cleanup` looks
 * exactly like a petname, and a human is perfectly entitled to name something
 * `floppy-panda` on purpose.
 *
 * Rows written before this flag existed have no recorded answer. They fall back
 * to what they did record, which is WRONG for the 1194 legacy petnames -- that
 * is a one-time data repair, tracked on the card, not something to guess at
 * here every time anyone reads a title.
 */
export function isEphemeralName(state: TitleState): boolean {
  if (!state.title) return true
  if (typeof state.titleEphemeral === 'boolean') return state.titleEphemeral
  // Pre-flag row: fall back to what it recorded. Wrong for the 1194 legacy
  // petnames, and deliberately NOT guessed at from the text -- see the card.
  if (state.titleOrigin) return !USER_AUTHORED.has(state.titleOrigin)
  return !state.titleUserSet
}

/** True once a title has been claimed intentionally -- by a human, or an agent
 *  acting for one via `rename_conversation` / `control_conversation`. */
function isPinned(state: TitleState): boolean {
  if (isEphemeralName(state)) return false
  return state.titleOrigin ? USER_AUTHORED.has(state.titleOrigin) : !!state.titleUserSet
}

/**
 * The stored write's clock, or `undefined` when the stored title predates this
 * module and was never stamped.
 *
 * A pinned-but-unstamped title is the migration case, and it MUST NOT read as
 * `0`: every historical `/rename` still sitting in a JSONL would then be newer
 * than the pin and would revert it on the next replay. `backfillTitleSetAt`
 * stamps those at hydrate so this stays a plain comparison.
 */
function storedClock(state: TitleState): number | undefined {
  return typeof state.titleSetAt === 'number' ? state.titleSetAt : undefined
}

/**
 * Decide a single write. Pure -- no mutation, no logging, no clock reads, so the
 * whole precedence table is testable without a store or a broker.
 *
 * `now` clamps a writer whose clock runs ahead of ours (a sentinel on a remote
 * host with a skewed clock would otherwise pin a title into the future and win
 * every subsequent comparison).
 */
export function decideTitleWrite(state: TitleState, write: TitleWrite, now: number): TitleVerdict {
  const title = write.title?.trim() || undefined
  if (title === state.title) return { accept: false, reason: 'unchanged' }

  // CC's own copy may SEED a title and never change one -- it is a mirror of
  // what we told CC, so anything it disagrees with is us having moved on.
  if (write.origin === 'cc-observed' && state.title) return { accept: false, reason: 'pinned' }
  if (!USER_AUTHORED.has(write.origin) && isPinned(state)) return { accept: false, reason: 'pinned' }

  const clamped = write.at !== undefined && write.at > now
  const at = write.at === undefined ? undefined : Math.min(write.at, now)

  const stored = storedClock(state)
  if (at !== undefined && stored !== undefined && at < stored) return { accept: false, reason: 'stale' }

  return { accept: true, at, clamped }
}

/**
 * Decide, then mutate `state` in place when the write wins. Returns whether
 * anything changed, matching the convention the transcript handlers use to
 * decide if a conversation update is worth broadcasting.
 *
 * `titleUserSet` is kept in step for every existing reader of it (spawn dialog,
 * daemon backend, away-summary, the REST snapshot) -- this module owns the
 * decision, not the field's audience.
 */
export function applyTitleWrite(state: TitleState, write: TitleWrite, now: number): TitleVerdict {
  const verdict = decideTitleWrite(state, write, now)
  if (!verdict.accept) return verdict

  state.title = write.title?.trim() || undefined
  // An accepted CLEAR releases ownership -- the conversation reverts to its auto
  // name, and CC must be free to title it again. The CLOCK still advances, so a
  // replayed older name cannot resurrect itself into the gap.
  state.titleOrigin = state.title ? write.origin : undefined
  state.titleUserSet = USER_AUTHORED.has(write.origin) && !!state.title
  // THE flag, recorded from the writer's own origin. An intentional rename
  // (`rename_conversation`, `control_conversation`, a human, a spawn that
  // supplied a name) CLEARS it; the automatic renamer writing its own guess
  // leaves it set, so its output stays replaceable by the next better guess.
  state.titleEphemeral = !state.title || !USER_AUTHORED.has(write.origin)
  state.titleSetAt = verdict.at ?? now
  return verdict
}

/**
 * The title a freshly-spawned conversation starts with.
 *
 * A name the requester supplied is THEIR choice and pins the conversation; a
 * generated one is `cc-auto` and stays fair game for CC's own titler. Shared by
 * every spawn backend so they cannot drift, and routed through the precedence
 * rule so a spawn is stamped with a clock like any other writer -- without one,
 * a `/rename` replayed out of an OLD transcript would outrank a name chosen
 * seconds ago.
 */
export function applySpawnTitle(state: TitleState, requestedName: string | undefined, generatedName: string): void {
  const now = Date.now()
  applyTitleWrite(
    state,
    { title: requestedName || generatedName, origin: requestedName?.trim() ? 'user' : 'cc-auto', at: now },
    now,
  )
}

/**
 * One-time stamp for titles pinned before this module existed.
 *
 * Called at hydrate. An unstamped pin means "set at some unknown point in the
 * past"; stamping it NOW makes every historical transcript entry older than it
 * (so a replayed `/rename` from May cannot revert it) while any live rename
 * that arrives afterwards is newer and still wins. Returns whether it stamped,
 * so the caller can mark the conversation dirty.
 */
export function backfillTitleSetAt(state: TitleState, now: number): boolean {
  // Gating on isPinned is what keeps an ephemeral petname from being promoted
  // to `origin: 'user'` by the line below -- which would make the 2026-08-19
  // freeze permanent and unrecoverable rather than merely wrong.
  if (state.titleSetAt !== undefined || !isPinned(state)) return false
  state.titleSetAt = now
  state.titleOrigin ??= 'user'
  return true
}
