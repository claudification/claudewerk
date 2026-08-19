import type { WallCommitRow, WallFrame, WallPulseRow } from '@shared/wall'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyWallFrame, getWallView, resetWallFrames, subscribe } from './wall-frame-store'

function row(id: string, over: Partial<WallPulseRow> = {}): WallPulseRow {
  return { id, project: 'claude://default/p', title: id, status: 'active', lastActivity: 1, ...over }
}

function commit(hash: string): WallCommitRow {
  return {
    hash,
    shortHash: hash,
    repoUri: 'claude://default/p',
    repoName: 'p',
    branch: 'main',
    subject: hash,
    authorName: 'jonas',
    insertions: 1,
    deletions: 0,
    fileCount: 1,
    committedAt: 1,
  }
}

let seq = 0
function frame(over: Partial<WallFrame> = {}): WallFrame {
  seq++
  return { type: 'wall_frame', seq, at: 1_000 + seq, full: false, coalesced: 1, ...over }
}

beforeEach(() => {
  seq = 0
  resetWallFrames()
})

describe('wall frame store', () => {
  it('a full frame REPLACES the picture; a delta folds into it', () => {
    applyWallFrame(frame({ full: true, pulse: { changed: [row('a'), row('b')] } }))
    expect(
      getWallView()
        .pulse.map(r => r.id)
        .sort(),
    ).toEqual(['a', 'b'])

    applyWallFrame(frame({ pulse: { changed: [row('c')] } }))
    expect(
      getWallView()
        .pulse.map(r => r.id)
        .sort(),
    ).toEqual(['a', 'b', 'c'])

    applyWallFrame(frame({ full: true, pulse: { changed: [row('z')] } }))
    expect(getWallView().pulse.map(r => r.id)).toEqual(['z'])
  })

  it('`gone` drops a row', () => {
    applyWallFrame(frame({ full: true, pulse: { changed: [row('a'), row('b')] } }))
    applyWallFrame(frame({ pulse: { changed: [], gone: ['a'] } }))
    expect(getWallView().pulse.map(r => r.id)).toEqual(['b'])
  })

  it('the latest row wins rather than accumulating duplicates', () => {
    applyWallFrame(frame({ pulse: { changed: [row('a', { lastActivity: 1 })] } }))
    applyWallFrame(frame({ pulse: { changed: [row('a', { lastActivity: 99 })] } }))
    expect(getWallView().pulse).toHaveLength(1)
    expect(getWallView().pulse[0]?.lastActivity).toBe(99)
  })

  it('counts a seq gap as a dropped frame without refetching anything', () => {
    applyWallFrame(frame({ pulse: { changed: [row('a')] } })) // seq 1
    seq += 2 // the broker dropped seq 2 and 3 for backpressure
    applyWallFrame(frame({ pulse: { changed: [row('a', { lastActivity: 9 })] } })) // seq 4
    const view = getWallView()
    expect(view.gaps).toBe(2)
    expect(view.pulse[0]?.lastActivity).toBe(9)
  })

  it('bounds the commit river instead of growing forever', () => {
    for (let i = 0; i < 400; i++) applyWallFrame(frame({ commits: [commit(`c${i}`)] }))
    const { commits } = getWallView()
    expect(commits).toHaveLength(300)
    expect(commits.at(-1)?.hash).toBe('c399')
  })

  it('notifies subscribers once per frame and hands back a stable snapshot', () => {
    let notifies = 0
    const off = subscribe(() => notifies++)
    const before = getWallView()
    expect(getWallView()).toBe(before) // stable between frames -- no tearing loop

    applyWallFrame(frame({ pulse: { changed: [row('a')] } }))
    expect(notifies).toBe(1)
    expect(getWallView()).not.toBe(before)
    off()
  })

  it('a reset clears the picture -- the resubscribe brings a fresh snapshot', () => {
    applyWallFrame(frame({ full: true, pulse: { changed: [row('a')] }, commits: [commit('c')] }))
    resetWallFrames()
    const view = getWallView()
    expect(view.pulse).toHaveLength(0)
    expect(view.commits).toHaveLength(0)
    expect(view.gaps).toBe(0)
  })
})
