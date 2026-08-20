/**
 * THE SEAM TEST THAT WAS MISSING.
 *
 * The epic seat tag was set by the spawn plan, declared on LaunchConfig, and
 * dropped twice on the way to the conversation -- once by the zod schema (no
 * `epic` field, so parse stripped the key) and once by the dispatch (which
 * copied `nightshift` and nothing else). Every epic test constructed
 * `launchConfig: { epic: tag }` BY HAND, so the whole subsystem stayed green
 * while production never produced that shape.
 *
 * These walk the REAL chain -- real spawn plan -> real schema -> real launch
 * config builder -- so a field that does not survive it fails here instead of
 * blinding the engine that was going to read it back.
 */

import { describe, expect, it } from 'bun:test'
import { planEpic } from '../shared/epic-ready'
import type { EpicRun } from '../shared/epic-run-store'
import { EPIC_RUN_DEFAULTS } from '../shared/epic-run-types'
import type { SpawnRequest } from '../shared/spawn-schema'
import { spawnRequestSchema } from '../shared/spawn-schema'
import {
  type EpicSpawnCtx,
  planImplementerSpawn,
  planOverseerSpawn,
  planPlannerSpawn,
  planVerifierSpawn,
} from './epic-spawn-plan'
import { buildLaunchConfig, WERK_TAGS } from './spawn-launch-config'

const PROJECT = 'claude://default/Users/jonas/projects/remote-claude'
const CTX: EpicSpawnCtx = { project: PROJECT, projectRoot: PROJECT, epicId: 'epic-the-wall', gen: 6 }

const RUN: EpicRun = {
  ...EPIC_RUN_DEFAULTS,
  epicId: 'epic-the-wall',
  project: PROJECT,
  status: 'running',
  gen: 6,
  dryGens: 0,
  spentUsd: 0,
  planned: true,
  created: '2026-08-19T11:00:00.000Z',
  updated: '2026-08-19T11:23:50.000Z',
  digest: '',
}

/** An empty board is a legitimate plan and keeps the fixture honest. */
const PLAN = planEpic({ cards: [], epicId: 'epic-the-wall', concurrency: 3, inFlight: [], inVerify: [] })

/** The four seats a run can dispatch, each from its REAL plan builder. */
const SEATS = [
  {
    role: 'overseer',
    plan: planOverseerSpawn(CTX, {
      projectUri: PROJECT,
      projectRoot: PROJECT,
      run: RUN,
      plan: PLAN,
      batonTail: '',
      wake: 'card-settled',
      settled: [],
    }),
  },
  {
    role: 'planner',
    plan: planPlannerSpawn(CTX, {
      projectUri: PROJECT,
      projectRoot: PROJECT,
      run: RUN,
      plan: PLAN,
      cardLines: [],
      epicBody: '# THE WALL',
    }),
  },
  { role: 'implementer', plan: planImplementerSpawn(CTX, 'wall-filter-store') },
  { role: 'verifier', plan: planVerifierSpawn(CTX, 'wall-filter-store') },
]

describe('the epic seat tag survives the spawn schema', () => {
  it('keeps a hand-built tag through a parse', () => {
    const parsed = spawnRequestSchema.parse({
      cwd: PROJECT,
      epic: { epicId: 'epic-the-wall', role: 'implementer', gen: 6, cardId: 'wall-filter-store' },
    })
    expect(parsed.epic).toEqual({ epicId: 'epic-the-wall', role: 'implementer', gen: 6, cardId: 'wall-filter-store' })
  })

  it.each(SEATS)('keeps the $role seat tag through a parse', ({ plan }) => {
    expect(spawnRequestSchema.parse(plan).epic).toEqual(plan.epic)
  })

  it('accepts a seat with no card -- the overseer and planner carry none', () => {
    expect(spawnRequestSchema.parse({ cwd: PROJECT, epic: { epicId: 'e1', role: 'overseer', gen: 0 } }).epic).toEqual({
      epicId: 'e1',
      role: 'overseer',
      gen: 0,
    })
  })

  it('rejects a tag with no epic id, rather than stripping it', () => {
    expect(() => spawnRequestSchema.parse({ cwd: PROJECT, epic: { role: 'overseer', gen: 0 } })).toThrow()
  })
})

describe('the spawn plan is not silently trimmed by the schema', () => {
  // Not a style check. A field the plan sets and the schema strips is invisible
  // at every layer below -- which is exactly how the seat tag was lost.
  it.each(SEATS)('$role: every planned field survives the parse', ({ plan }) => {
    const parsed = spawnRequestSchema.parse(plan) as Record<string, unknown>
    const planned = plan as unknown as Record<string, unknown>
    expect(Object.keys(planned).filter(k => planned[k] !== undefined && parsed[k] === undefined)).toEqual([])
  })
})

describe('buildLaunchConfig persists the werk tags', () => {
  const base: SpawnRequest = { cwd: PROJECT }
  const resolved = { headless: true }

  it('carries the epic seat tag onto the conversation', () => {
    const epic = { epicId: 'epic-the-wall', role: 'verifier' as const, gen: 6, cardId: 'wall-filter-store' }
    expect(buildLaunchConfig({ ...base, epic }, resolved, undefined).epic).toEqual(epic)
  })

  it('carries the nightshift tag onto the conversation', () => {
    const nightshift = { runId: '2026-08-19', taskId: '002' }
    expect(buildLaunchConfig({ ...base, nightshift }, resolved, undefined).nightshift).toEqual(nightshift)
  })

  it('omits a werk tag the request did not carry', () => {
    const cfg = buildLaunchConfig(base, resolved, undefined)
    expect(cfg.epic).toBeUndefined()
    expect(cfg.nightshift).toBeUndefined()
  })

  it('carries EVERY declared werk tag -- a new one must be wired, never hand-copied', () => {
    const cfg = buildLaunchConfig(
      { ...base, epic: { epicId: 'e', role: 'overseer', gen: 1 }, nightshift: { runId: 'r', taskId: 't' } },
      resolved,
      undefined,
    ) as unknown as Record<string, unknown>
    for (const tag of WERK_TAGS) expect(cfg[tag]).toBeDefined()
  })

  it('still resolves the sentinel-profile intent', () => {
    expect(buildLaunchConfig({ ...base, profile: 'work' }, resolved, undefined).sentinelProfile).toEqual({
      kind: 'profile',
      name: 'work',
    })
    expect(buildLaunchConfig({ ...base, pool: 'work' }, resolved, undefined).sentinelProfile).toEqual({
      kind: 'pool',
      name: 'work',
    })
  })
})
