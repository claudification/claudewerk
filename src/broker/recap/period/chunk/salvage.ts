/**
 * SALVAGE -- recover what is recoverable from a malformed map-stage response.
 *
 * Incident 2026-07-28 (`recap_zquf15w44ufh`, portal2 last-30d, $9.08): Sonnet-5
 * returned a COMPLETE response (finish_reason=stop, 889 tokens) whose `dead_ends`
 * array mixed the string form and the Item form:
 *
 *     "dead_ends":["Tried the AWS Support API ...","conversations":["488cbece"]],
 *
 * One stray key inside one array made `JSON.parse` throw, `parseMapOutput` gave
 * up on the WHOLE object, and that conversation's entire extraction -- goals,
 * discoveries, open_questions, gotchas, frustrations, all of it valid and all of
 * it sitting right there in the response -- was dropped from the recap.
 *
 * So: never let one bad array cost the other fourteen. This scans the response
 * for TOP-LEVEL keys, reads each value independently, and inside an array keeps
 * the elements that parse while dropping the ones that do not. Truncation comes
 * out in the wash -- a response cut mid-array loses only the partial tail
 * element, because every complete element before it still parses.
 *
 * Deliberately NOT a JSON repair library: it never guesses intent, never
 * re-balances brackets, never invents a value. Whatever it cannot read is
 * REPORTED as lost (`SalvageResult.keys[].dropped`) -- a silent drop is the
 * exact bug this module exists to kill.
 */

import type { RecapMetadata } from '../../../../shared/protocol'
import { scanTopLevelEntries, splitElements } from '../../shared/json-scan'
import { coerceMapObject } from './map-prompt'
import { makeEmptyMetadata } from './merge'

/** The 15 array-valued keys of RecapMetadata, derived from the empty shape so
 *  this never drifts from the real type. Anything else in the response (a stray
 *  `subtitle`, a hallucinated key) is ignored rather than reported as a loss. */
const ARRAY_KEYS = Object.keys(makeEmptyMetadata())

export interface SalvagedKey {
  key: string
  /** Elements that survived BOTH the parse and the shape coercion. */
  kept: number
  /** Elements the response contained that we could not use. */
  dropped: number
}

export interface SalvageResult {
  metadata: RecapMetadata
  /** Per-key accounting, only for keys the response actually contained. */
  keys: SalvagedKey[]
  /** Total elements recovered. 0 means there was nothing worth keeping. */
  recovered: number
  /** Total elements lost. >0 means this chunk is INCOMPLETE -- surface it. */
  dropped: number
  /** Keys whose value could not be read at all (not even element-wise). */
  lostKeys: string[]
}

/** Recover as much of a malformed map response as the text allows. Never throws:
 *  a response with nothing recoverable comes back as empty metadata with
 *  `recovered: 0`, which the caller treats as a hard chunk failure. */
export function salvageMapOutput(raw: string): SalvageResult {
  const entries = scanTopLevelEntries(raw)
  const obj: Record<string, unknown> = {}
  const rawCounts = new Map<string, number>()
  const lostKeys: string[] = []
  for (const [key, text] of entries) {
    if (!ARRAY_KEYS.includes(key)) continue
    const read = readValue(text)
    if (read === null) {
      lostKeys.push(key)
      continue
    }
    obj[key] = read.value
    rawCounts.set(key, read.rawCount)
  }
  // Account AFTER coercion: an element that parsed as JSON but is the wrong
  // shape (the string sitting in an Item[] above) is still a loss, and saying
  // otherwise would be the same silent-success lie in a new place.
  const metadata = coerceMapObject(obj)
  const keys: SalvagedKey[] = []
  for (const [key, rawCount] of rawCounts) {
    const coerced = metadata[key as keyof RecapMetadata]
    const kept = Array.isArray(coerced) ? coerced.length : 0
    keys.push({ key, kept, dropped: Math.max(0, rawCount - kept) })
  }
  for (const key of lostKeys) keys.push({ key, kept: 0, dropped: 0 })
  return {
    metadata,
    keys,
    recovered: keys.reduce((n, k) => n + k.kept, 0),
    dropped: keys.reduce((n, k) => n + k.dropped, 0),
    lostKeys,
  }
}

/** One-line summary for a log line / failure record. */
export function describeSalvage(result: SalvageResult): string {
  const lossy = result.keys.filter(k => k.dropped > 0).map(k => `${k.key} -${k.dropped}`)
  const head = `salvaged ${result.recovered} item(s)`
  if (result.lostKeys.length > 0) lossy.push(`unreadable: ${result.lostKeys.join(', ')}`)
  return lossy.length > 0 ? `${head} (lost: ${lossy.join('; ')})` : head
}

interface ReadValue {
  value: unknown
  /** Elements the response held for this key, before shape coercion. */
  rawCount: number
}

/** Parse one value text, falling back to element-wise recovery for an array. */
function readValue(text: string): ReadValue | null {
  const whole = tryParse(text)
  if (whole !== undefined) return { value: whole, rawCount: Array.isArray(whole) ? whole.length : 1 }
  if (text[0] !== '[') return null
  const elements = splitElements(text)
  const value: unknown[] = []
  for (const el of elements) {
    const parsed = tryParse(el)
    if (parsed !== undefined) value.push(parsed)
  }
  return { value, rawCount: elements.length }
}

function tryParse(text: string): unknown {
  try {
    const value = JSON.parse(text) as unknown
    // `undefined` is our "did not parse" signal and JSON can never produce it,
    // but `null` can -- normalise so a literal null is not mistaken for failure.
    return value === null ? [] : value
  } catch {
    return undefined
  }
}
