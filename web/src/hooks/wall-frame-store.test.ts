import type { CardMove, WallCommitRow, WallFrame, WallPlanSample, WallPulseRow } from '@shared/wall'
import { beforeEach, describe, expect, it } from 'vitest'
import { getCardLedger } from './card-ledger-feed'
import { applyWallFrame, getWallView, resetWallFrames, setWallFrameHold, subscribe } from './wall-frame-store'

function move(id: string): CardMove {
  return { id, project: 'claude://default/p', title: id, from: 'open', to: 'done', ts: 1 }
}

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
  // Order matters: release the hold FIRST so a suite that left one on cannot
  // drain its buffered frames into the next test's picture.
  setWallFrameHold(false)
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

/**
 * THE HOLD -- W1's "while rewound, live frames stop mutating what is displayed.
 * They keep arriving and buffering; releasing to 0 snaps forward."
 *
 * Everything here is about the two ways a naive implementation goes wrong: it
 * drops the frames instead of queueing them (so the release leaves a hole the
 * next snapshot has to repair), or it replays them more than once (so the commit
 * river grows a second copy of every row that arrived during the rewind).
 */
describe('wall frame store: the time cursor holds the fold', () => {
  it('a held frame does not move the picture, and does not notify', () => {
    applyWallFrame(frame({ full: true, pulse: { changed: [row('a')] } }))
    let notifies = 0
    const off = subscribe(() => notifies++)

    setWallFrameHold(true)
    applyWallFrame(frame({ pulse: { changed: [row('b')] } }))
    applyWallFrame(frame({ commits: [commit('c1')] }))

    expect(getWallView().pulse.map(r => r.id)).toEqual(['a'])
    expect(getWallView().commits).toHaveLength(0)
    expect(notifies).toBe(0)
    off()
  })

  it('SNAPS FORWARD on release: nothing lost, nothing doubled, one notify', () => {
    applyWallFrame(frame({ full: true, commits: [commit('c0')] }))
    setWallFrameHold(true)
    for (let i = 1; i <= 5; i++) applyWallFrame(frame({ commits: [commit(`c${i}`)] }))

    let notifies = 0
    const off = subscribe(() => notifies++)
    setWallFrameHold(false)

    // Every commit that arrived while rewound is here, in order, ONCE.
    expect(getWallView().commits.map(c => c.hash)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5'])
    // Six buffered frames, ONE repaint. Folding thirteen panes per frame would
    // redraw the wall six times to show the state they add up to.
    expect(notifies).toBe(1)
    // ...and no gap was invented by holding: the seqs were consecutive.
    expect(getWallView().gaps).toBe(0)
    off()
  })

  it('releasing with nothing buffered leaves the picture exactly as it was', () => {
    applyWallFrame(frame({ full: true, pulse: { changed: [row('a')] } }))
    const before = getWallView()

    setWallFrameHold(true)
    setWallFrameHold(false)

    // Identity, not equality: a needless rebuild here would re-render every pane
    // on the wall for a rewind the user immediately let go of.
    expect(getWallView()).toBe(before)
  })

  it('a held FULL frame discards what was queued behind it', () => {
    setWallFrameHold(true)
    applyWallFrame(frame({ pulse: { changed: [row('a')] } }))
    applyWallFrame(frame({ full: true, pulse: { changed: [row('z')] } }))
    setWallFrameHold(false)

    // The snapshot replaced the picture, so replaying the delta that preceded it
    // would resurrect a row the broker just said is gone.
    expect(getWallView().pulse.map(r => r.id)).toEqual(['z'])
  })

  it('REPORTS an overflowed buffer as a seq gap rather than hiding the loss', () => {
    applyWallFrame(frame({ full: true }))
    setWallFrameHold(true)
    // Past the cap the oldest frames are dropped. That IS a loss, and it surfaces
    // through the same `gaps` counter a broker-side drop uses -- the one number
    // the wall already prints -- instead of through a quietly wrong picture.
    for (let i = 0; i < 700; i++) applyWallFrame(frame({ commits: [commit(`c${i}`)] }))
    setWallFrameHold(false)

    const view = getWallView()
    expect(view.commits).toHaveLength(300)
    expect(view.commits.at(-1)?.hash).toBe('c699')
    expect(view.gaps).toBe(100)
  })

  it('a disconnect while rewound still clears the picture, and empties the buffer', () => {
    applyWallFrame(frame({ full: true, pulse: { changed: [row('a')] } }))
    setWallFrameHold(true)
    applyWallFrame(frame({ pulse: { changed: [row('b')] } }))

    // A disconnect is NOT a live frame. What the hold suspends is the picture
    // moving under a reader; this is the picture ceasing to be vouched for, and
    // a rewound wall must not go on drawing it.
    resetWallFrames()
    expect(getWallView().pulse).toHaveLength(0)
    expect(getWallView().historyLostAt).not.toBeNull()

    // The buffered frame went with it -- it described a stream that no longer
    // exists, and replaying it on release would put `b` back under a fresh
    // snapshot that never mentioned it.
    setWallFrameHold(false)
    expect(getWallView().pulse).toHaveLength(0)
  })
})

/**
 * The section map's two edges -- the ones a straight `if (frame.x)` per section
 * would get wrong, and which the `Record<WallSection, merge>` fold exists to
 * keep right.
 */
describe('wall frame store: the section map', () => {
  it('a FULL frame with no cards EMPTIES the ledger rather than leaving it', () => {
    applyWallFrame(frame({ cards: [move('a'), move('b')] }))
    expect(getCardLedger()).toHaveLength(2)

    // The section is absent, not empty. A per-section presence check would skip
    // the merge here and leave yesterday's moves under today's snapshot.
    applyWallFrame(frame({ full: true, pulse: { changed: [row('z')] } }))
    expect(getCardLedger()).toHaveLength(0)
  })

  it('IGNORES a section this build has no merge for instead of throwing', () => {
    // An older tab against a newer broker. It should draw less of the wall, not
    // die on every frame at 2 Hz.
    const fromTheFuture = { ...frame({ pulse: { changed: [row('a')] } }), quests: [{ id: 'q1' }] }
    expect(() => applyWallFrame(fromTheFuture as WallFrame)).not.toThrow()
    expect(getWallView().pulse.map(r => r.id)).toEqual(['a'])
  })
})

/** `plan` is the one section that is a SERIES rather than a latest value. It is
 *  also the one a flat FIFO would silently corrupt: interleave two profiles and
 *  the busier one evicts the quieter one's history, leaving S2 drawing a line
 *  with a hole in it that looks exactly like real data. */
describe('wall frame store: the plan series', () => {
  const T = 1_760_000_000_000

  function plan(over: Partial<WallPlanSample> = {}): WallPlanSample {
    return { profile: 'default', utilization: 40, at: T, state: 'ok', ...over }
  }

  it('accumulates a series rather than keeping the latest sample', () => {
    applyWallFrame(frame({ at: T, plan: [plan({ at: T, utilization: 10 })] }))
    applyWallFrame(frame({ at: T + 1_000, plan: [plan({ at: T + 1_000, utilization: 20 })] }))

    expect(getWallView().plan.map(p => p.utilization)).toEqual([10, 20])
  })

  it('does not let a busy profile evict a quiet one', () => {
    applyWallFrame(frame({ at: T, plan: [plan({ profile: 'quiet', at: T })] }))
    for (let i = 1; i <= 400; i++) {
      const at = T + i * 1_000
      applyWallFrame(frame({ at, plan: [plan({ profile: 'busy', at, utilization: i % 100 })] }))
    }

    expect(getWallView().plan.filter(p => p.profile === 'quiet')).toHaveLength(1)
  })

  it('keeps only the last five hours', () => {
    applyWallFrame(frame({ at: T, plan: [plan({ at: T })] }))
    const later = T + 5 * 60 * 60 * 1000 + 60_000
    applyWallFrame(frame({ at: later, plan: [plan({ at: later, utilization: 7 })] }))

    expect(getWallView().plan.map(p => p.utilization)).toEqual([7])
  })

  it('a full frame replaces the series, so a resubscribe is not a double history', () => {
    applyWallFrame(frame({ at: T, plan: [plan({ at: T, utilization: 10 })] }))
    applyWallFrame(frame({ at: T + 1_000, full: true, plan: [plan({ at: T + 1_000, utilization: 55 })] }))

    expect(getWallView().plan.map(p => p.utilization)).toEqual([55])
  })
})
