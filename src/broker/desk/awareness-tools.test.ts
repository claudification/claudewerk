import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SotuView } from '../../shared/protocol'
import { closeProjectStore, getOrCreateProject, initProjectStore } from '../project-store'
import { awarenessTools } from './awareness-tools'
import type { SheafSummary } from './fleet-sheaf'
import type { ToolContext } from './tool-def'

const ARR = 'claude://default/Users/jonas/projects/arr'
const ctx: ToolContext = {}

function view(narrative: string, alerts: string[] = []): SotuView {
  return {
    project: ARR,
    enabled: true,
    chronicle: { now: [], justDone: [], narrative, pipelineVersion: 1, generatedAt: 7 },
    holds: [],
    alerts: alerts as SotuView['alerts'],
    builtAt: 7,
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awt-'))
  initProjectStore(dir)
  getOrCreateProject(ARR, 'arr')
})
afterEach(() => {
  closeProjectStore()
  rmSync(dir, { recursive: true, force: true })
})

describe('state_of_union', () => {
  test('project mode: regenerates on read, then returns the assembled view', async () => {
    const distilled: string[] = []
    const tools = awarenessTools({
      viewOf: () => view('arr shipped the indexer.', ['unpushed']),
      distillOnRead: async uri => {
        distilled.push(uri)
      },
    })
    const out = (await tools.state_of_union.execute({ project: 'arr' }, ctx)) as {
      project: string
      narrative: string
      alerts: string[]
      brief: string
    }
    expect(distilled).toEqual([ARR])
    expect(out.project).toBe('arr')
    expect(out.narrative).toBe('arr shipped the indexer.')
    expect(out.alerts).toEqual(['unpushed'])
    expect(out.brief).toContain('State of the Union')
  })

  test('project mode: unknown project -> error, no distill', async () => {
    const tools = awarenessTools({
      viewOf: () => view('x'),
      distillOnRead: async () => {
        throw new Error('must not be called')
      },
    })
    const out = (await tools.state_of_union.execute({ project: 'no-such-project-xyz' }, ctx)) as { error?: string }
    expect(out.error).toContain('no project matching')
  })

  test('project mode: a failed distill degrades to the current view', async () => {
    const tools = awarenessTools({
      viewOf: () => view('current truth'),
      distillOnRead: async () => {
        throw new Error('openrouter down')
      },
    })
    const out = (await tools.state_of_union.execute({ project: 'arr' }, ctx)) as { narrative: string }
    expect(out.narrative).toBe('current truth')
  })

  test('fleet mode: unions every project with signal', async () => {
    const tools = awarenessTools({ viewOf: () => view('arr is humming.') })
    const out = (await tools.state_of_union.execute({ project: null }, ctx)) as { fleet: string }
    expect(out.fleet).toContain('## arr')
    expect(out.fleet).toContain('arr is humming.')
  })
})

describe('fleet_sheaf', () => {
  const summary: SheafSummary = {
    windowH: 24,
    totals: { projects: 1, conversations: 2, trees: 1, costUsd: 3.5 },
    projects: [{ project: 'arr', costUsd: 3.5, conversations: 2, trees: 1, inputTokens: 10, outputTokens: 5 }],
  }

  test('returns the compact summary from the provider', async () => {
    const windows: number[] = []
    const tools = awarenessTools({
      sheafOf: w => {
        windows.push(w)
        return summary
      },
    })
    const out = (await tools.fleet_sheaf.execute({ windowH: null }, ctx)) as SheafSummary
    expect(windows).toEqual([24])
    expect(out.totals.costUsd).toBe(3.5)
  })

  test('clamps the window and degrades when unbound', async () => {
    const windows: number[] = []
    const tools = awarenessTools({
      sheafOf: w => {
        windows.push(w)
        return null
      },
    })
    const out = (await tools.fleet_sheaf.execute({ windowH: 500 }, ctx)) as { error?: string }
    expect(windows).toEqual([168])
    expect(out.error).toContain('sheaf unavailable')
  })
})
