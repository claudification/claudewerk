import type { PulseBand } from './bands'

/**
 * The Pulse filter grammar — ONE box, no mode switch.
 *
 *   free text   substring over title + project + action + tag
 *   !           only NEEDS YOU
 *   !!          NEEDS YOU + WORKING (the two bands that are "live")
 *   @proj       scope to a project
 *   #tag        scope to a branch / worktree / agent name
 *   ~30m        time window; also ~90s ~2h ~1d (bare number means minutes)
 *   ~2026-08-14 ONE calendar day, in the reader's own zone — not a window back
 *               from now. Both forms ride the `~` sigil because both are the
 *               same question ("when"), and a surface that split them across two
 *               sigils would have to teach the reader which one it meant.
 *   $1          cost floor in USD — spent at least this much ($0.5 works)
 *   %80         context pressure floor — at or past this % of the window
 *   &host       scope to a sentinel / host
 *   :opus       scope to a model
 *   ^eng        scope to a WORKSPACE — the sidebar tier ABOVE the project
 *   -x          EXCLUDE — negates free text or any scope: -@anvil, -#wip, -noise
 *   "x" 'x'     LITERAL — no sigils, no exclusion. `rm "-rf"` searches for -rf.
 *   +over       REVEAL managed rows (epic seats, nightshift), hidden by default
 *   +only       with +over: show ONLY managed rows
 *
 * On the sigils, having checked what the world already means by them: `#` (tag),
 * `$` (money), `%` (percent) and `~` (time) line up with common usage. Two are
 * knowing departures: fzf reads `!` as NEGATION, and URLs/shells read `&` as
 * AND. `!` is kept for "needs you" because priority-bang is the stronger reading
 * on a STATUS surface — and `-` carries exclusion, so `!` never has to mean NOT.
 * `&` is safe in practice because every filter already ANDs implicitly, so
 * nobody ever needs to type an AND.
 *
 * `^` (workspace) is the newest and had exactly two ASCII sigils left to choose
 * from, `^` and `=`. It is NOT `:` — Jonas's sketch was `:y`, and `:` already
 * means MODEL, so a workspace on that sigil would either shadow `:opus` or make
 * one token mean two things depending on which names happened to exist. `^`
 * reads as "up a level", which is exactly what a workspace is relative to a
 * project, and `-^eng` still parses at a glance where `-=eng` reads as the
 * compound-assignment operator and looks like a typo.
 *
 * Deliberately NOT handled here: `>` command mode. Pulse is a sibling surface to
 * the command palette, and `>` is that palette's own prefix — the caller detects
 * it and hands off rather than us shadowing it.
 *
 * Tokens are position-independent and combine with AND. Unknown tokens fall
 * through to free text, so a stray `@` never eats the query.
 */
export interface PulseQuery {
  /** Free-text remainder, lowercased, space-joined. */
  text: string
  /** Band whitelist, or null for "every band". */
  bands: readonly PulseBand[] | null
  project: string | null
  tag: string | null
  /** Max age in ms, or null for unbounded. */
  windowMs: number | null
  /**
   * `YYYY-MM-DD` — keep only rows that fall on THIS calendar day, or null.
   *
   * A SECOND, DISJOINT shape of the same axis, and it exists because the
   * activity matrix needed a click on a square from six months ago to mean
   * something. `windowMs` can only ever say "the last N", which reaches
   * backwards from now and therefore cannot name a Tuesday in March; the time
   * cursor tops out at three hours. Both live on the `time` axis, so a pane that
   * already declared it honours a day with no wiring of its own.
   *
   * Resolved against the READER's zone at match time, which is the same zone the
   * grid asked the server to bucket in — so the square you clicked and the rows
   * you get back agree by construction.
   */
  day: string | null
  /** Minimum spend in USD. */
  minCostUsd: number | null
  /** Minimum context-window pressure, 0-100. */
  minContextPct: number | null
  host: string | null
  model: string | null
  /**
   * `^eng` — scope to a WORKSPACE, the sidebar tier above the project.
   *
   * Matched against a row's workspace NAMES, never its ids: a workspace id is
   * `ws-mfk2p1` (see `workspace-actions.ts`), which nobody is going to type.
   * Membership is many-to-many, so a row carries a LIST and this matches if ANY
   * entry hits — see `PulseSearchable.workspaces`.
   */
  workspace: string | null
  /** `+over` — include machine-dispatched rows, which are hidden by default. */
  includeManaged: boolean
  /** `+only` — with includeManaged, show ONLY those rows. */
  onlyManaged: boolean
  /** Exclusions, gathered from `-` tokens. Any hit here rejects the row. */
  not: PulseExclusions
}

/** The `-x` half of the grammar. Every field is an OR: matching ANY excludes. */
export interface PulseExclusions {
  text: string[]
  projects: string[]
  tags: string[]
  hosts: string[]
  models: string[]
  workspaces: string[]
  bands: PulseBand[]
}

/** Anything Pulse can filter. Kept structural so tests don't need a Conversation. */
export interface PulseSearchable {
  title: string
  project: string
  action: string
  tag?: string
  /** Age in ms at match time. */
  ageMs: number
  band: PulseBand
  costUsd?: number
  contextPct?: number
  host?: string
  model?: string
  /**
   * `^` axis — EVERY workspace this row's project sits in, by NAME.
   *
   * A list because membership is many-to-many by design: a project can be in
   * zero workspaces or in five, and `workspace-membership.ts` says out loud that
   * the reverse "the workspace of this project" lookup was deleted on purpose.
   * Absent or empty means "in no workspace", which matches no `^` token — absent
   * is never a wildcard, same rule as `host` and `model`.
   */
  workspaces?: readonly string[]
  /** Machine-dispatched (epic seat / nightshift). Hidden unless `+over`. */
  managed?: boolean
}

export const noExclusions = (): PulseExclusions => ({
  text: [],
  projects: [],
  tags: [],
  hosts: [],
  models: [],
  workspaces: [],
  bands: [],
})

export const EMPTY_QUERY: PulseQuery = {
  text: '',
  bands: null,
  project: null,
  tag: null,
  windowMs: null,
  day: null,
  minCostUsd: null,
  minContextPct: null,
  host: null,
  model: null,
  workspace: null,
  includeManaged: false,
  onlyManaged: false,
  not: noExclusions(),
}
