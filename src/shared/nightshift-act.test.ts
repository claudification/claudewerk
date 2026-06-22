/**
 * Tests for the NIGHTSHIFT act-on-results spawn builder (plan §4): every ACT
 * button -> a worktree-correct SpawnRequest pointed at .nightshift/latest.
 */
import { describe, expect, test } from 'bun:test'
import { buildActSpawn, type NightshiftActKind } from './nightshift-act'

const URI = 'claude://default/Users/jonas/projects/remote-claude'
const ROOT = '/Users/jonas/projects/remote-claude'

describe('buildActSpawn', () => {
  test('resolves cwd to the project root (acts run on main, no worktree)', () => {
    const s = buildActSpawn({ kind: 'integrate', projectUri: URI, runId: '2026-06-22' })
    expect(s.cwd).toBe(ROOT)
    expect(s.worktree).toBeUndefined()
    expect(s.headless).toBe(true)
  })

  test('prompt points at the absolute artifact folder + the contract', () => {
    const s = buildActSpawn({ kind: 'integrate', projectUri: URI, runId: '2026-06-22' })
    expect(s.prompt).toContain(`${ROOT}/.nightshift/latest`)
    expect(s.prompt).toContain(URI)
    expect(s.prompt).toContain('ready-to-review')
    expect(s.prompt).toContain('git merge --ff-only')
    // reports back via the patch action
    expect(s.prompt).toContain('action=patch')
  })

  test('each kind builds a distinct, labelled job', () => {
    const kinds: NightshiftActKind[] = ['integrate', 'test', 'bundle', 'discard', 'freeform']
    const names = kinds.map(kind => buildActSpawn({ kind, projectUri: URI, runId: '2026-06-22' }).name)
    expect(new Set(names).size).toBe(kinds.length)
    expect(names.every(n => n.startsWith('act:'))).toBe(true)
  })

  test('test-all prompt forbids integrating', () => {
    const s = buildActSpawn({ kind: 'test', projectUri: URI, runId: '2026-06-22' })
    expect(s.prompt).toContain('Do NOT integrate')
  })

  test('bundle prompt names the bundle branch', () => {
    const s = buildActSpawn({ kind: 'bundle', projectUri: URI, runId: '2026-06-22' })
    expect(s.prompt).toContain('nightshift-bundle/2026-06-22')
  })

  test('task filter scopes the prompt + the label', () => {
    const s = buildActSpawn({
      kind: 'discard',
      projectUri: URI,
      runId: '2026-06-22',
      taskIds: ['003'],
      freeform: 'flaky',
    })
    expect(s.prompt).toContain('003')
    expect(s.prompt).toContain('flaky')
    expect(s.name).toContain('#003')
  })

  test('freeform carries Jonas instruction', () => {
    const s = buildActSpawn({
      kind: 'freeform',
      projectUri: URI,
      runId: '2026-06-22',
      freeform: 'integrate 1 and 2, open a PR for 3',
    })
    expect(s.prompt).toContain('integrate 1 and 2, open a PR for 3')
  })

  test('rejects a URI with no real project root', () => {
    expect(() => buildActSpawn({ kind: 'integrate', projectUri: 'claude://default/', runId: '2026-06-22' })).toThrow()
  })
})
