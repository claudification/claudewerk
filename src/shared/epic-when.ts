/**
 * THE `when` AXIS -- every reason a run may not dispatch YET, on one field.
 *
 * `when` is not a new concept beside `cadence`: it IS `cadence`, widened. The
 * field was always a PER-BEAT DISPATCH PREDICATE rather than a one-shot arm-time
 * choice -- `window` is re-evaluated on every beat (`epic-executor.ts`), not
 * consulted once when the run was armed -- so every other "may it start yet"
 * question belongs on the same axis rather than beside it as its own verb:
 *
 *   epic_run action=start when=now      no gate (the default)
 *   epic_run action=start when=window   defers to the project's night window
 *   epic_run action=start when=queue    waits until no other epic is running
 *   epic_run action=start when=2026-08-22T02:00:00+07:00
 *                                       waits until an APPOINTMENT passes
 *
 * Three things fall out, and they are why this is one axis and not four verbs:
 * ONE place answers "why isn't this running", the gates COMPOSE by construction
 * (`when=[window, queue]` -- ALL must pass), and `action=start` keeps meaning
 * "arm this run", so nothing about the existing verb has to be re-taught.
 *
 * THE FIELD IS STILL SPELLED `cadence` ON THE ARTIFACT AND ON THE WIRE, and that
 * is deliberate: renaming it would need a migration of every `run.md` on disk AND
 * would break the broker/sentinel version skew rule (they deploy separately, so a
 * new broker meets an old sentinel that only knows `cadence` -- and the failure
 * mode is a `window` run dispatching at noon). `when` is its name on the VERB
 * surface, where a human types it; `cadence` is its name in storage.
 *
 * A GATE IS NOT A CAP. Headroom and the spend/wall-clock ceilings are refusals
 * that apply to every run regardless of `when` -- they are not a scheduling
 * choice a human made, so they are not values here (see `runner-headroom-admission`).
 */

import type { EpicCadence, EpicWhenInstant } from './epic-run-types'
import { formatRelative } from './format-when'

/**
 * Every NAMED gate, in CANONICAL ORDER. `parseWhen` sorts by this, so
 * `[queue, window]` and `[window, queue]` are the same stored value -- two
 * spellings of one axis would make the run artifact churn and the board
 * fingerprint jitter for no reason a reader could see.
 *
 * The INSTANT gate is not in this list because it is not one value: it is an
 * infinite family (`at:<iso>`), matched by shape rather than by name. It sorts
 * LAST, after every named gate, so no `run.md` that predates it changes shape.
 */
const WHEN_GATES: readonly EpicCadence[] = ['now', 'window', 'queue']

/** `now` is the ABSENCE of a gate, so it never rides alongside a real one. */
const NO_GATE: EpicCadence = 'now'

/** The prefix that marks an instant gate on the artifact and on the wire. */
const AT = 'at:'

function isGate(v: string): v is EpicCadence {
  return (WHEN_GATES as readonly string[]).includes(v)
}

/**
 * ONE TOKEN of a `when` spelling: an INSTANT or a bare word.
 *
 * A TOKENIZER RATHER THAN A SPLIT, and that is not tidying -- it is the only way
 * this axis can carry an instant at all. The joined spelling a model actually
 * types is `when=window+2026-08-22T02:00:00+07:00`, and an ISO offset CONTAINS
 * the `+` the joined spelling separates on. `split(/[,+]/)` would tear
 * `+07:00` off the appointment and leave behind a timestamp that parses to a
 * different hour -- which, for a gate whose whole job is to fire at a stated
 * time, is the worst possible way to be wrong.
 *
 * The time half is OPTIONAL so a bare date (`2026-08-22`) is still recognised as
 * an appointment rather than falling through to "unknown token". Unknown tokens
 * are DROPPED, and a dropped appointment means the run dispatches IMMEDIATELY --
 * the one direction this gate must never fail in.
 */
const TOKEN_RE = /(?:at:)?\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:z|[+-]\d{2}:?\d{2})?|[a-z]+/gi

/** The trailing zone designator of an ISO instant, when it carries one. */
const OFFSET_RE = /(z|[+-]\d{2}:?\d{2})$/i

/** `+0700` / `+07:00` -> `+07:00`. One spelling on disk, so two runs armed for
 *  the same moment are the same bytes. */
function normalizeOffset(offset: string): string {
  const sign = offset[0]
  const digits = offset.slice(1).replace(':', '')
  return `${sign}${digits.slice(0, 2)}:${digits.slice(2)}`
}

function offsetMinutes(offset: string): number {
  const sign = offset[0] === '-' ? -1 : 1
  const digits = offset.slice(1).replace(':', '')
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)))
}

/** ISO with the millisecond field dropped when it is zero. `.000` on every
 *  appointment is noise in a file a human reads mid-run. */
function trimMillis(iso: string): string {
  return iso.replace('.000', '')
}

/**
 * One instant token -> the canonical gate plus the moment it names.
 *
 * TWO RULES, both of which exist because the same string must mean the same
 * INSTANT on the broker (a UTC container) and on the sentinel (Jonas's machine,
 * UTC+7):
 *
 *   1. A ZONELESS date-time IS READ AS UTC, explicitly. `Date.parse` reads that
 *      form as LOCAL time per the ES spec, so the identical `run.md` would name
 *      two different moments depending on which process read it. Reading it as
 *      UTC is also the SAFE direction to be wrong in: the run waits longer than
 *      the human meant rather than firing early.
 *   2. The offset the caller gave is PRESERVED, not folded to UTC. It is the only
 *      record of which clock the human was reading, and the scheduled-tasks rule
 *      (`format-when.ts`) is that no surface may render a bare time.
 */
function readInstant(token: string): { gate: EpicWhenInstant; atMs: number } | null {
  const raw = token.trim().replace(/^at:/i, '')
  const found = raw.match(OFFSET_RE)
  const offset = found ? found[1] : null
  const body = (offset ? raw.slice(0, -offset.length) : raw).replace(' ', 'T')
  const withTime = /T\d{2}:/i.test(body) ? body : `${body}T00:00:00`
  const zone = !offset || offset.toLowerCase() === 'z' ? 'Z' : normalizeOffset(offset)
  const atMs = Date.parse(`${withTime}${zone}`)
  if (!Number.isFinite(atMs)) return null
  const wall =
    zone === 'Z'
      ? new Date(atMs).toISOString()
      : `${new Date(atMs + offsetMinutes(zone) * 60_000).toISOString().slice(0, -1)}${zone}`
  return { gate: `${AT}${trimMillis(wall)}`, atMs }
}

/** Does this gate name an appointment? Shape, not a lookup -- the instant gate is
 *  a family of values rather than one. */
export function isWhenInstant(gate: string): gate is EpicWhenInstant {
  return gate.toLowerCase().startsWith(AT)
}

/**
 * Whatever a caller sent -> the normalised gate list.
 *
 * Accepts every spelling a caller will actually produce: a bare scalar
 * (`"window"`, and every run.md written before this axis existed), a real list
 * (`["window","queue"]`), a joined string (`"window,queue"` / `"window+queue"`,
 * which is what a model types and what survives a frontmatter round trip), and
 * an ISO instant in any of those positions.
 *
 * Unknown tokens are DROPPED rather than rejected: this parses artifacts written
 * by a newer engine as well as by an older one, and a run whose gate list came
 * back empty must fall back to "no gate" -- the state every run was in before
 * this field could hold more than one value.
 *
 * TWO INSTANTS COLLAPSE TO THE LATEST. Every gate must pass on the same beat, so
 * an earlier appointment is unconditionally satisfied by the time a later one is;
 * carrying both would be the same fact stated twice and two countdowns to keep
 * in step.
 */
export function parseWhen(v: unknown): EpicCadence[] {
  const src = Array.isArray(v) ? v.map(String).join(',') : String(v ?? '')
  const named = new Set<string>()
  let latest: { gate: EpicWhenInstant; atMs: number } | null = null
  for (const [token] of src.matchAll(TOKEN_RE)) {
    const lower = token.trim().toLowerCase()
    if (isGate(lower)) {
      named.add(lower)
      continue
    }
    const instant = readInstant(token)
    if (instant && (!latest || instant.atMs > latest.atMs)) latest = instant
  }
  const real = WHEN_GATES.filter(g => g !== NO_GATE && named.has(g))
  const gates: EpicCadence[] = latest ? [...real, latest.gate] : real
  return gates.length === 0 ? [NO_GATE] : gates
}

/**
 * The list as frontmatter wants it: a lone gate stays a BARE SCALAR.
 *
 * Not cosmetic. Every `run.md` on disk says `cadence: now` or `cadence: window`,
 * and emitting `cadence: [now]` for all of them would rewrite six live artifacts
 * to say the same thing in a shape their previous readers never produced. A list
 * is only written when there genuinely is one.
 *
 * An instant survives both shapes unquoted -- `at:2026-08-22T02:00:00+07:00`
 * carries no `": "`, no trailing colon and no comma, which is every rule
 * `frontmatter.ts` quotes for.
 */
export function serializeWhen(gates: readonly EpicCadence[]): string | string[] {
  const list = parseWhen(gates)
  return list.length === 1 ? list[0] : [...list]
}

/**
 * Does this run carry this gate?
 *
 * PARSES RATHER THAN INDEXES, because the value may not be a list. Broker and
 * sentinel deploy separately, and a sentinel running the older bundle reads
 * `cadence` through a scalar `pick()` -- so a run snapshot can arrive over the
 * wire as the bare string it always used to be. Asking `.includes` of that would
 * answer by SUBSTRING, which is right by accident for `window` and wrong the
 * moment a gate name contains another.
 */
export function gatedBy(gates: readonly EpicCadence[] | string | undefined, gate: EpicCadence): boolean {
  return parseWhen(gates).includes(gate)
}

/**
 * THE APPOINTMENT THIS RUN CARRIES, or null when it carries none.
 *
 * Takes the wire value in whatever shape it arrived, for `gatedBy`'s reason. The
 * canonical gate string comes back beside the instant so a caller can print the
 * appointment exactly as it is stored -- including the offset, which is the only
 * record of which clock the human was reading when they set it.
 */
export function whenInstant(
  gates: readonly EpicCadence[] | string | undefined,
): { gate: EpicWhenInstant; iso: string; atMs: number } | null {
  for (const gate of parseWhen(gates)) {
    if (!isWhenInstant(gate)) continue
    const read = readInstant(gate)
    if (read) return { gate: read.gate, iso: read.gate.slice(AT.length), atMs: read.atMs }
  }
  return null
}

/**
 * Has the appointment passed? A run with no appointment is always permitted.
 *
 * Kept beside the codec rather than in `epic-beat.ts` so the ENGINE and every
 * surface that reports the wait reach the answer through the same arithmetic --
 * a rail that decided the countdown differently from the beat would be a rail
 * that lies about the engine, which is the failure `epic-queue.ts` is shared to
 * prevent one gate over.
 */
export function whenInstantPassed(gates: readonly EpicCadence[] | string | undefined, nowMs: number): boolean {
  const instant = whenInstant(gates)
  return instant === null || nowMs >= instant.atMs
}

/**
 * ONE LINE FOR A RUN THAT IS WAITING ON THE CLOCK, or null when it is not.
 *
 * NEVER A BARE TIME (`format-when.ts`): the instant is printed with the offset it
 * was set in AND as a relative countdown, so it can be checked against a wall
 * clock in any zone. The countdown is the half that matters -- a WAITING run and
 * a STALLED one are indistinguishable on every other line of every surface this
 * engine has, which is exactly why the restart quarantine logs a countdown on
 * every held tick.
 */
export function whenWaitingLine(gates: readonly EpicCadence[] | string | undefined, nowMs: number): string | null {
  const instant = whenInstant(gates)
  if (!instant || nowMs >= instant.atMs) return null
  return `waiting until ${instant.iso} (${formatRelative(instant.atMs, nowMs)})`
}

/** One gate, as a human reads it. An instant reads as the appointment it is. */
function formatGate(gate: EpicCadence): string {
  return isWhenInstant(gate) ? `not before ${gate.slice(AT.length)}` : gate
}

/** For a human or an agent: `now`, `window`, `window + not before 2026-08-22T02:00:00+07:00`.
 *  Takes the wire value in whatever shape it arrived, for `gatedBy`'s reason. */
export function formatWhen(gates: readonly EpicCadence[] | string | undefined): string {
  return parseWhen(gates).map(formatGate).join(' + ')
}
