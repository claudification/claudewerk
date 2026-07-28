import { describe, expect, test } from 'bun:test'
import type { RecapChunkFailure } from '../../../shared/protocol'
import { acceptPartial, describeResolution } from './resolve'
import type { RecapRow } from './store'

const FAILURES: RecapChunkFailure[] = [
  {
    chunkIndex: 148,
    outcome: 'failed',
    conversations: [{ id: '488cbece-b42', title: 'AWS SES production access' }],
    error: 'map JSON parse failed',
    at: 1,
  },
]

function makeDeps(row: Partial<RecapRow>) {
  const updates: Array<Record<string, unknown>> = []
  const logs: Array<{ message: string; phase: string }> = []
  const full = { id: 'recap_x', status: 'partial', failuresJson: JSON.stringify(FAILURES), ...row } as RecapRow
  return {
    deps: {
      store: {
        get: () => full,
        update: (_id: string, patch: Record<string, unknown>) => updates.push(patch),
        appendLog: (entry: { message: string; phase: string }) => logs.push(entry),
      },
    } as never,
    updates,
    logs,
  }
}

describe('acceptPartial', () => {
  test('records the decision without touching the status', () => {
    const { deps, updates } = makeDeps({})
    const result = acceptPartial(deps, 'recap_x', 'jonas')
    expect(result.accepted).toBe(1)
    expect(result.resolution.mode).toBe('accept')
    expect(result.resolution.by).toBe('jonas')
    // ACCEPT IS NOT A REWRITE: the recap stays partial and keeps its casualties.
    // Flipping it to 'done' would erase the fact that data is missing.
    expect(updates).toHaveLength(1)
    expect(Object.keys(updates[0] ?? {})).toEqual(['resolutionJson'])
  })

  test('the recorded note names what was signed off', () => {
    const { deps } = makeDeps({})
    const result = acceptPartial(deps, 'recap_x')
    expect(result.resolution.note).toContain('AWS SES production access')
  })

  test('writes the decision to the log trail', () => {
    const { deps, logs } = makeDeps({})
    acceptPartial(deps, 'recap_x', 'jonas')
    expect(logs[0]?.phase).toBe('resolve')
    expect(logs[0]?.message).toContain('ACCEPTED as-is by jonas')
  })

  test('refuses a recap that is not partial', () => {
    const { deps } = makeDeps({ status: 'done' })
    expect(() => acceptPartial(deps, 'recap_x')).toThrow('not partial')
  })

  test('refuses a failed recap -- there is no document to accept', () => {
    const { deps } = makeDeps({ status: 'failed' })
    expect(() => acceptPartial(deps, 'recap_x')).toThrow('not partial')
  })

  test('survives a corrupt casualty list rather than refusing to settle', () => {
    const { deps } = makeDeps({ failuresJson: '{not json' })
    expect(acceptPartial(deps, 'recap_x').accepted).toBe(0)
  })

  test('a missing recap is an error, not a silent no-op', () => {
    const deps = { store: { get: () => null, update: () => {}, appendLog: () => {} } } as never
    expect(() => acceptPartial(deps, 'nope')).toThrow('not found')
  })
})

describe('describeResolution', () => {
  test('every mode has a human label', () => {
    expect(describeResolution('retry_failed')).toContain('re-running')
    expect(describeResolution('synthesize_only')).toContain('abandoning')
    expect(describeResolution('accept')).toContain('as-is')
  })
})
