import { describe, expect, test } from 'bun:test'
import type { SotuTargetHold, SotuView } from '../../shared/protocol'
import type { ProjectOverviewRow } from './overview'
import { buildSotuBlockBody, sotuSection } from './sotu-context'

function row(project: string, uri: string): ProjectOverviewRow {
  return { project, projectUri: uri, brief: '', live: 0, working: 0, needsYou: 0, recencyWeight: 1 }
}

function view(overrides: Partial<SotuView> = {}): SotuView {
  return {
    project: 'claude:///p',
    enabled: true,
    chronicle: { now: [], justDone: [], narrative: '', pipelineVersion: 1, generatedAt: 0 },
    holds: [],
    alerts: [],
    builtAt: 0,
    ...overrides,
  }
}

function hold(target: string, contended: boolean): SotuTargetHold {
  return { kind: 'claim', target, holders: [{ convId: 'a', since: 1 }], contended }
}

describe('sotuSection', () => {
  test('null when the view has nothing to say', () => {
    expect(sotuSection('rclaude', view())).toBeNull()
  })

  test('renders narrative headline + alerts + contended targets', () => {
    const v = view({
      chronicle: {
        now: [],
        justDone: [],
        narrative: 'Recap engine landed.\nNext: deploy.\nThird line ignored.',
        pipelineVersion: 1,
        generatedAt: 5,
      },
      alerts: ['at-risk', 'unpushed'],
      holds: [hold('src/a.ts', true), hold('src/b.ts', false)],
    })
    const s = sotuSection('rclaude', v)
    expect(s).toContain('## rclaude')
    expect(s).toContain('Recap engine landed. Next: deploy.')
    expect(s).not.toContain('Third line')
    expect(s).toContain('git: at-risk, unpushed')
    expect(s).toContain('CONTENDED (1): src/a.ts')
    expect(s).not.toContain('src/b.ts')
  })
})

describe('buildSotuBlockBody', () => {
  test('empty when no project has signal', () => {
    const body = buildSotuBlockBody([row('a', 'claude:///a')], 0, { viewOf: () => view() })
    expect(body).toBe('')
  })

  test('packs sections under the budget and counts drops', () => {
    const rows = [row('one', 'claude:///one'), row('two', 'claude:///two'), row('three', 'claude:///three')]
    const viewOf = () =>
      view({
        chronicle: { now: [], justDone: [], narrative: 'x'.repeat(120), pipelineVersion: 1, generatedAt: 5 },
      })
    const body = buildSotuBlockBody(rows, 0, { viewOf, budgetChars: 300 })
    expect(body).toContain('## one')
    expect(body).toContain('## two')
    expect(body).toContain('(+1 more -- use state_of_union)')
  })

  test('tolerates a null view (store unavailable)', () => {
    const body = buildSotuBlockBody([row('a', 'claude:///a')], 0, { viewOf: () => null })
    expect(body).toBe('')
  })
})
