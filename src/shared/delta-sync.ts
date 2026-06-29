/**
 * Delta sync: compact state patches via microdiff.
 *
 * The broker diffs previous-broadcast vs current summary per conversation.
 * When the patch is smaller than the full object, it sends a
 * `conversation_patch` message instead of the full `conversation_update`.
 * The client applies the patch to its local store entry.
 */
import diff, { type Difference } from 'microdiff'

export type { Difference }
export type DeltaPatch = Difference[]

export function diffState<T extends object>(prev: T, next: T): DeltaPatch {
  return diff(prev, next)
}

/**
 * Apply a microdiff patch to a base object. Returns a shallow clone with
 * changes applied (does not mutate the input).
 */
// fallow-ignore-next-line complexity
export function applyPatch<T extends object>(base: T, diffs: DeltaPatch): T {
  if (diffs.length === 0) return base
  const out = structuredClone(base)
  for (const d of diffs) {
    let target: any = out
    for (let i = 0; i < d.path.length - 1; i++) {
      target = target[d.path[i]]
      if (target == null) break
    }
    if (target == null) continue
    const key = d.path[d.path.length - 1]
    if (d.type === 'REMOVE') {
      if (Array.isArray(target)) target.splice(key as number, 1)
      else delete target[key]
    } else {
      target[key] = d.value
    }
  }
  return out
}

/**
 * Decide whether to send a patch or the full object.
 * Returns { mode: 'patch', diffs, json } or { mode: 'full' }.
 *
 * The size gate compares serialized patch bytes against full-object bytes.
 * Patch overhead (type/path wrappers per change) means a patch that touches
 * most fields can exceed the full object -- in that case, send full.
 */
export function deltaOrFull<T extends object>(
  prev: T | undefined,
  next: T,
  nextJson: string,
): { mode: 'patch'; diffs: DeltaPatch; json: string } | { mode: 'full' } {
  if (!prev) return { mode: 'full' }

  const diffs = diffState(prev, next)
  if (diffs.length === 0) return { mode: 'patch', diffs: [], json: '[]' }

  const patchJson = JSON.stringify(diffs)
  if (patchJson.length < nextJson.length) {
    return { mode: 'patch', diffs, json: patchJson }
  }
  return { mode: 'full' }
}
