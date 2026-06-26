/**
 * SOTU per-project state.json -- trigger bookkeeping.
 *
 * Holds the small mutable counters the activity-driven trigger (Phase 4) reads:
 * lastDistillAt, pendingContribs (weighted), genAt, pipelineVersion. Overwritten
 * in place. Reading before any write returns a fresh `emptyState()`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { statePath } from './paths'
import { emptyState, SOTU_PIPELINE_VERSION, type SotuState } from './types'

/** Read the project's trigger state, or a fresh empty state if none exists.
 *  A state from an older pipeline version is reset to empty (replay gate). */
export function readState(slug: string): SotuState {
  const p = statePath(slug)
  if (!existsSync(p)) return emptyState()
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as SotuState
    if (parsed.pipelineVersion !== SOTU_PIPELINE_VERSION) return emptyState()
    return parsed
  } catch {
    return emptyState()
  }
}

/** Write the project's trigger state (overwrite). */
export function writeState(slug: string, state: SotuState): void {
  writeFileSync(statePath(slug), `${JSON.stringify(state, null, 2)}\n`)
}

/** Read-modify-write helper: apply a mutation and persist. Returns the new state. */
export function updateState(slug: string, mutate: (s: SotuState) => SotuState): SotuState {
  const next = mutate(readState(slug))
  writeState(slug, next)
  return next
}
