import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type ActivityBroadcaster, publishEpicActivity, resetActivityPublisher } from './epic-activity-publish'
import { resetBeatLog } from './epic-beat-log'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { forgetArmedEpic, noteArmedEpic, resetArmedEpics } from './epic-registry'
import type { SweepDeps } from './epic-sweep-loop'

const ALPHA = 'claude://default/Users/jonas/projects/alpha'
const BETA = 'claude://default/Users/jonas/projects/beta'

const deps = { getAllConversations: () => [], isLive: () => true, log: () => {} } as unknown as SweepDeps

interface Sent {
  project: string
  message: Record<string, unknown>
}

function spy(): ActivityBroadcaster & { sent: Sent[] } {
  const sent: Sent[] = []
  return { sent, broadcastConversationScoped: (message, project) => void sent.push({ project, message }) }
}

beforeEach(() => {
  resetArmedEpics()
  resetBeatLog()
  resetEpicIo()
  resetActivityPublisher()
  configureEpicIo({
    fetchEpicRun: (async () => ({ run: { status: 'running', gen: 1, maxGens: 8 }, baton: [], lease: null })) as never,
  })
})

// Module-global state + one bun process = cleaning up only on the way IN leaves
// the last case's arming visible to the next FILE. See epic-active.test.ts.
afterEach(() => {
  resetArmedEpics()
  resetBeatLog()
  resetEpicIo()
  resetActivityPublisher()
})

describe('publishEpicActivity', () => {
  test('sends one message per project, carrying only that project rows', async () => {
    noteArmedEpic(ALPHA, 'a1')
    noteArmedEpic(ALPHA, 'a2')
    noteArmedEpic(BETA, 'b1')
    const target = spy()

    await publishEpicActivity(deps, target)

    expect(target.sent).toHaveLength(2)
    const alpha = target.sent.find(s => s.project === ALPHA)
    expect((alpha?.message.epicActivity as unknown[]).length).toBe(2)
    expect(alpha?.message.type).toBe('epic_activity')
    const beta = target.sent.find(s => s.project === BETA)
    expect((beta?.message.epicActivity as { epicId: string }[])[0]?.epicId).toBe('b1')
  })

  test('scopes each message to its own project so the existing gate does the filtering', async () => {
    noteArmedEpic(BETA, 'b1')
    const target = spy()

    await publishEpicActivity(deps, target)

    expect(target.sent[0]?.project).toBe(BETA)
  })

  test('a project whose last run settles gets ONE final empty message', async () => {
    noteArmedEpic(ALPHA, 'a1')
    const target = spy()
    await publishEpicActivity(deps, target)

    forgetArmedEpic(ALPHA, 'a1')
    await publishEpicActivity(deps, target)

    expect(target.sent).toHaveLength(2)
    expect(target.sent[1]).toMatchObject({ project: ALPHA })
    expect(target.sent[1]?.message.epicActivity).toEqual([])
  })

  test('and then goes quiet -- an idle box broadcasts nothing at all', async () => {
    noteArmedEpic(ALPHA, 'a1')
    const target = spy()
    await publishEpicActivity(deps, target)
    forgetArmedEpic(ALPHA, 'a1')
    await publishEpicActivity(deps, target)

    await publishEpicActivity(deps, target)
    await publishEpicActivity(deps, target)

    expect(target.sent).toHaveLength(2)
  })

  test('a failing feed is logged, never thrown -- the sweep must not die for the UI', async () => {
    configureEpicIo({
      fetchEpicRun: (() => {
        throw new Error('boom')
      }) as never,
    })
    noteArmedEpic(ALPHA, 'a1')
    const lines: string[] = []
    const target = spy()

    // listActiveEpicRuns catches per-row, so this still publishes a degraded
    // row rather than nothing -- the assertion that matters is that it resolves.
    await publishEpicActivity({ ...deps, log: (l: string) => void lines.push(l) } as SweepDeps, target)

    expect(target.sent).toHaveLength(1)
    expect((target.sent[0]?.message.epicActivity as { status: null }[])[0]?.status).toBeNull()
  })
})
