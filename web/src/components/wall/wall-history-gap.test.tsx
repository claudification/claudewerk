/**
 * A RESTARTED BROKER IS A HOLE IN THE SERIES, AND THE WALL SAYS SO.
 *
 * S1's sparklines and S2's 5h graph are ACCUMULATED from wall frames. The broker
 * holds them in two in-memory Maps (`cpuRings`, `series`), so `docker compose up
 * -d` empties both; the socket drops, the client throws its own copy away on the
 * resubscribe, and the panes come back with a few seconds of data that refills in
 * real time.
 *
 * That picture is INDISTINGUISHABLE from a quiet fleet, and this surface exists
 * to be trusted from across a room. So the rule these tests pin: after a restart
 * the wall REPORTS the lost history rather than rendering the rebuilt series as
 * if it were the whole story.
 *
 * `wall-vitals-history-store` is flushing the broker's rings to a database, which
 * shrinks the hole. It cannot close it -- whatever accumulated since the last
 * flush is genuinely gone -- so this line is needed either way.
 */

import type { WallFrame, WallPlanSample } from '@shared/wall'
import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyWallFrame, clearWallHistoryGap, getWallView, resetWallFrames } from '@/hooks/wall-frame-store'
import { stubWallHttp } from './wall-feed-stubs'
import { installWallTestHooks, openTheWall, pane } from './wall-test-utils'

vi.mock('@/hooks/project-task-wire', () => ({
  sendBoardOp: vi.fn(async () => ({ pinned: [] })),
  installProjectHandler: vi.fn(),
}))
vi.mock('@/lib/epic-inspect-api', () => ({
  fetchActiveRuns: vi.fn(async () => ({ ok: true, data: [] })),
  inspectRun: vi.fn(async () => ({ ok: true, data: null })),
}))

let seq = 0
function frame(over: Partial<WallFrame> = {}): WallFrame {
  seq++
  return { type: 'wall_frame', seq, at: 1_000 + seq, full: false, coalesced: 1, ...over }
}

const sample = (at: number): WallPlanSample => ({ profile: 'work', node: 'studio', utilization: 40, at, state: 'ok' })

/** Push the frames a live wall would have folded in before anything went wrong. */
function livePicture(): void {
  act(() => {
    applyWallFrame(frame({ full: true, plan: [sample(1_001)] }))
    applyWallFrame(frame({ plan: [sample(1_002)] }))
  })
}

/** The broker went away and came back with EMPTY rings: the socket reset drops
 *  our copy, the resubscribe answers with a snapshot that has no history in it. */
function restartBroker(): void {
  act(() => {
    resetWallFrames()
    applyWallFrame(frame({ full: true, plan: [] }))
  })
}

installWallTestHooks()

beforeEach(() => {
  seq = 0
  // This suite is about the PUSH half; the pull-fed panes simply have to mount
  // without their own requests throwing under them.
  stubWallHttp()
  resetWallFrames()
  clearWallHistoryGap()
})

describe('lost history after a broker restart', () => {
  it('remembers WHEN the series was cut, and does not forget it on the next frame', () => {
    livePicture()
    expect(getWallView().historyLostAt).toBe(null)

    restartBroker()

    // The gap does not heal, it only ages -- so the full snapshot that follows
    // the resubscribe must not quietly clear the mark it arrived alongside.
    expect(getWallView().historyLostAt).toBeGreaterThan(0)
    expect(getWallView().plan).toEqual([])
  })

  it('does not invent a gap on the first connection', () => {
    // A wall opening for the first time resets a picture that never had anything.
    // Reporting lost history there would put a permanent scare on a clean boot.
    resetWallFrames()
    expect(getWallView().historyLostAt).toBe(null)
  })

  it('S1 and S2 report the loss rather than drawing an empty window as data', async () => {
    await openTheWall()
    livePicture()
    restartBroker()

    for (const code of ['S1', 'S2']) {
      const gap = pane(code)?.querySelector('.wall-history-gap')
      expect(gap?.textContent).toMatch(/history before \d\d:\d\d lost to a reconnect/)
    }
    // And the plan pane is NOT drawing a chart off a series it no longer has.
    expect(pane('S2')?.querySelector('.wall-plan')).toBe(null)
  })
})
