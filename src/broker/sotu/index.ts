/**
 * SOTU (State of the Union) -- broker module barrel.
 *
 * Phase 0 surface: domain types, the file-store (queue / chronicle / state), the
 * path layout, and the read-only LLM-engine seam. Later phases add the wire
 * handlers (Phase 1), git-fabric scan (Phase 2), callout channel (Phase 3),
 * distill engine (Phase 4), and read surfaces (Phase 5/6).
 *
 * Design: `.claude/docs/plan-state-of-union.md`.
 */

import { initSotuPaths } from './paths'

/** Initialize the SOTU file store. Idempotent; call once at broker boot with
 *  the broker's cache dir (mirrors initCanvasStore / initAnalyticsStore). */
export function initSotuStore(cacheDir: string): void {
  initSotuPaths(cacheDir)
}

export { readChronicle, readChronicleMd, renderChronicleMd, writeChronicle } from './chronicle'
// recordContribution / contribWeight are consumed directly from './contribute' by
// the handler + floor (and the distill engine in Phase 4) -- re-exported here once
// the barrel gains an external consumer, per the "grows per phase" seam rule.
export { startSotuFloor, stopSotuFloor } from './floor'
// Path helpers are re-exported as their consumers land (queuePath/statePath/...
// are used internally by the store; the barrel surfaces only what callers need).
export { FLEET_SLUG, projectDir, projectSlug, sanitizeSlug, sotuRootDir } from './paths'
export { appendContribution, isExpired, readLiveQueue, readQueue } from './queue'
export { readState, updateState, writeState } from './state'
export * from './types'
