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
// `maybeDistillOnRead` (read-triggered regen) is consumed from the barrel by the
// Phase-5 REST route. The MCP handler imports it directly from './engine'.
export { maybeDistillOnRead, startSotuEngine, stopSotuEngine } from './engine'
// Phase-7 eval surface -- recent distill recipes + cost + grounding (recap D mirror),
// consumed by the sotu_eval handler + the REST eval route.
export { readDistillEvals } from './eval'
// Phase-6 fleet rollup -- enriches the Sheaf response (consumed by the sheaf route).
export { enrichSheafWithSotu } from './fleet'
export { startSotuFloor, stopSotuFloor } from './floor'
// gatherGitFabric / GitFabricTransport are consumed directly by git-scan.ts (and
// the Phase-4 distill engine later) -- barrel re-export lands with that external
// consumer, per the "grows per phase" seam rule (avoids the fallow dead-export gate).
export { startSotuGitScan, stopSotuGitScan } from './git-scan'
// Path helpers are re-exported as their consumers land (queuePath/statePath/...
// are used internally by the store; the barrel surfaces only what callers need).
export { FLEET_SLUG, projectDir, projectSlug, sanitizeSlug, sotuRootDir } from './paths'
export { appendContribution, isExpired, readLiveQueue, readQueue } from './queue'
// Phase-5 SessionStart inject -- the compact brief a new conversation spawns with.
export { sotuSpawnBrief } from './spawn-brief'
export { readState, updateState, writeState } from './state'
export * from './types'
// Phase-5 read model -- `buildSotuView` is the ONE assembler, consumed from the
// barrel by the REST route + the dispatcher tie-in. `deriveHolds`/`deriveAlerts`/
// `renderSotuBrief` are consumed directly from './view' (internally + by spawn-brief).
export { buildSotuView } from './view'
