import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SotuConfigView, SotuDistillEval } from '../../../shared/protocol'
import { deleteProjectSettings } from '../../project-settings'
import { initSotuStore, projectSlug } from '../../sotu'
import { recordContribution } from '../../sotu/contribute'
import { registerSotuConfigHandlers } from '../sotu-config'
import { runHandler as run, trustSettings as settings } from './sotu-harness'

// The Phase-7 tuning + eval handlers. `ProjectSettings` is an in-module map (a write
// persists in memory even without a KV store), so a write -> read round-trips here.

const PROJECT = 'claude://host/cfgproj'

beforeAll(() => registerSotuConfigHandlers())

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sotu-cfg-'))
  initSotuStore(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  deleteProjectSettings(PROJECT)
})

function configure(data: Record<string, unknown>, trust: 'default' | 'benevolent' = 'benevolent') {
  const { replies } = run(
    'sotu_configure_request',
    { requestId: 'c-1', projectUri: PROJECT, ...data },
    {},
    settings(trust),
  )
  return replies[0] as { ok: boolean; config?: SotuConfigView; error?: string }
}

describe('sotu_configure handler', () => {
  it('rejects a non-benevolent agent-host', () => {
    const r = configure({}, 'default')
    expect(r).toMatchObject({ ok: false, error: 'Requires benevolent trust level' })
  })

  it('rejects when no project resolves', () => {
    const { replies } = run('sotu_configure_request', { requestId: 'c-x' }, {}, settings('benevolent'))
    expect(replies[0]).toMatchObject({ ok: false, error: 'no resolvable project' })
  })

  it('reads the resolved config (default OFF, baked tuning) without mutating', () => {
    const r = configure({})
    expect(r.ok).toBe(true)
    expect(r.config?.enabled).toBe(false)
    expect(r.config?.overrides).toEqual({})
    expect(r.config?.tuning.scribeModel).toBe('anthropic/claude-haiku-4.5')
  })

  it('writes enabled + stakes + budget + params, returns the resolved config', () => {
    const r = configure({
      enabled: true,
      stakes: 'side',
      budgetDailyUsd: 2,
      params: { scribeModel: 'x/cheap', burstThreshold: 4 },
    })
    expect(r.config?.enabled).toBe(true)
    expect(r.config?.stakes).toBe('side')
    // explicit daily cap wins; monthly inherits the 'side' stakes default
    expect(r.config?.budget).toMatchObject({ dailyUsd: 2, monthlyUsd: 8 })
    expect(r.config?.tuning.scribeModel).toBe('x/cheap')
    expect(r.config?.tuning.burstThreshold).toBe(4)
    expect(r.config?.overrides).toEqual({ scribeModel: 'x/cheap', burstThreshold: 4 })
  })

  it('a stakes default fills the budget when no explicit cap is set', () => {
    const r = configure({ enabled: true, stakes: 'experiment' })
    expect(r.config?.budget).toEqual({ dailyUsd: 0.25, monthlyUsd: 2 })
  })

  it('a null param clears a prior override; clearing all drops the overrides', () => {
    configure({ params: { scribeModel: 'x/cheap', burstThreshold: 4 } })
    const r = configure({ params: { scribeModel: null, burstThreshold: null } })
    expect(r.config?.overrides).toEqual({})
    expect(r.config?.tuning.scribeModel).toBe('anthropic/claude-haiku-4.5') // back to default
  })

  it('ignores garbage params (NaN / blank / unknown key)', () => {
    const r = configure({ params: { burstThreshold: Number.NaN, scribeModel: '  ', bogus: 5 } })
    expect(r.config?.overrides).toEqual({})
  })
})

describe('sotu_eval handler', () => {
  it('rejects a non-benevolent agent-host', () => {
    const { replies } = run('sotu_eval_request', { requestId: 'e-1', projectUri: PROJECT }, {}, settings('default'))
    expect(replies[0]).toMatchObject({ ok: false, error: 'Requires benevolent trust level' })
  })

  it('returns an empty list for a project with no distills', () => {
    const { replies } = run('sotu_eval_request', { requestId: 'e-2', projectUri: PROJECT }, {}, settings('benevolent'))
    const r = replies[0] as { ok: boolean; evals: SotuDistillEval[] }
    expect(r.ok).toBe(true)
    expect(r.evals).toEqual([])
  })

  it('reads back a recorded distill eval (recipe + grounding)', async () => {
    // Enable + seed a contribution, then run a distill so a bundle lands on disk.
    configure({ enabled: true })
    const slug = projectSlug(PROJECT)
    recordContribution(slug, { kind: 'turn_digest', convId: 'c1', ts: 10, intent: 'auth' }, PROJECT)
    const { runDistill } = await import('../../sotu/distill/run')
    const { defaultResolveSotuConfig } = await import('../../sotu/config')
    await runDistill(
      {
        chat: async () => ({
          content: JSON.stringify({ now: [{ convId: 'c1', detail: 'auth', ts: 1 }], justDone: [], narrative: 'x' }),
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.03,
            costSource: 'litellm' as const,
          },
        }),
        broadcast: () => {},
        now: () => 1_234_000,
      },
      { slug, project: PROJECT, config: defaultResolveSotuConfig(PROJECT) },
    )
    const { replies } = run('sotu_eval_request', { requestId: 'e-3', projectUri: PROJECT }, {}, settings('benevolent'))
    const r = replies[0] as { ok: boolean; evals: SotuDistillEval[] }
    expect(r.evals).toHaveLength(1)
    expect(r.evals[0]).toMatchObject({ ts: 1_234_000, mode: 'scribe', costUsd: 0.03 })
    expect(r.evals[0]?.recipe.scribeModel).toBe('anthropic/claude-haiku-4.5')
    expect(r.evals[0]?.grounding?.precision).toBe(1)
  })
})
