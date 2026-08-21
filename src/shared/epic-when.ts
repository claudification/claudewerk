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
 *
 * Three things fall out, and they are why this is one axis and not three verbs:
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

import type { EpicCadence } from './epic-run-types'

/**
 * Every gate, in CANONICAL ORDER. `parseWhen` sorts by this, so `[queue, window]`
 * and `[window, queue]` are the same stored value -- two spellings of one axis
 * would make the run artifact churn and the board fingerprint jitter for no
 * reason a reader could see.
 */
export const WHEN_GATES: readonly EpicCadence[] = ['now', 'window', 'queue']

/** `now` is the ABSENCE of a gate, so it never rides alongside a real one. */
const NO_GATE: EpicCadence = 'now'

function isGate(v: string): v is EpicCadence {
  return (WHEN_GATES as readonly string[]).includes(v)
}

/**
 * Whatever a caller sent -> the normalised gate list.
 *
 * Accepts all three spellings a caller will actually produce: a bare scalar
 * (`"window"`, and every run.md written before this axis existed), a real list
 * (`["window","queue"]`), and a joined string (`"window,queue"` / `"window+queue"`,
 * which is what a model types and what survives a frontmatter round trip).
 *
 * Unknown tokens are DROPPED rather than rejected: this parses artifacts written
 * by a newer engine as well as by an older one, and a run whose gate list came
 * back empty must fall back to "no gate" -- the state every run was in before
 * this field could hold more than one value.
 */
export function parseWhen(v: unknown): EpicCadence[] {
  const raw = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[,+]/)
  const gates = raw.map(s => s.trim().toLowerCase()).filter(isGate)
  const real = [...new Set(gates)].filter(g => g !== NO_GATE)
  if (real.length === 0) return [NO_GATE]
  return WHEN_GATES.filter(g => real.includes(g))
}

/**
 * The list as frontmatter wants it: a lone gate stays a BARE SCALAR.
 *
 * Not cosmetic. Every `run.md` on disk says `cadence: now` or `cadence: window`,
 * and emitting `cadence: [now]` for all of them would rewrite six live artifacts
 * to say the same thing in a shape their previous readers never produced. A list
 * is only written when there genuinely is one.
 */
export function serializeWhen(gates: readonly EpicCadence[]): string | string[] {
  const list = parseWhen(gates)
  return list.length === 1 ? list[0] : [...list]
}

/** Does this run carry this gate? */
export function gatedBy(gates: readonly EpicCadence[] | undefined, gate: EpicCadence): boolean {
  return (gates ?? []).includes(gate)
}

/** For a human or an agent: `now`, `window`, `window + queue`. */
export function formatWhen(gates: readonly EpicCadence[] | undefined): string {
  return parseWhen(gates).join(' + ')
}
