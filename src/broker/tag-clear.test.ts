/**
 * THE RULE: a tag comes off on EVIDENCE the work happened, never on the seat
 * exiting.
 *
 * The two cases this file exists for are the first two in `decideTagClear`'s
 * block: a KILLED seat leaves the tag ON, and a seat whose work LANDED leaves it
 * OFF. Everything else here is the boundary around those two -- the states in
 * which clearing would be a guess rather than a fact.
 */

import { describe, expect, test } from 'bun:test'
import type { ProjectTask, ProjectTaskMeta } from '../shared/project-task-types'
import type { CallBoard } from './board-cards'
import type { ConversationStore } from './conversation-store'
import { clearCardTag, decideTagClear, drainTag, type TagClearInput } from './tag-clear'

const TAG = 'needs-refine'

/** Every fact TRUE -- the clearing case. Each test negates the one it is about,
 *  so a rule that stopped consulting a field fails here rather than passing by
 *  accident on a fixture that never exercised it. */
function facts(over: Partial<TagClearInput> = {}): TagClearInput {
  return { tagged: true, seatLive: false, seatSettled: true, workLanded: true, ...over }
}

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status: 'open',
    title: slug,
    tags: [TAG],
    refs: [],
    created: '2026-08-01T00:00:00.000Z',
    mtime: 1000,
    bodyPreview: '',
    ...over,
  }
}

describe('decideTagClear', () => {
  test('a seat that ran and landed its work clears the tag', () => {
    expect(decideTagClear(facts())).toEqual({ clear: true })
  })

  /**
   * THE CARD. A werk-refiner killed at step 6 has settled -- it ran, it exited --
   * and produced nothing. Clearing on that exit is what would leave the card
   * untagged, unworked and invisible.
   */
  test('a KILLED seat leaves the tag ON', () => {
    expect(decideTagClear(facts({ workLanded: false }))).toEqual({ clear: false, reason: 'no-evidence' })
  })

  /**
   * THE OTHER HALF. Without a seat requirement the engine would drain a queue
   * nobody served: a human tags a card, edits it thirty seconds later, and the
   * engine reads the edit as work it never dispatched.
   */
  test('evidence with no seat behind it clears nothing', () => {
    expect(decideTagClear(facts({ seatSettled: false }))).toEqual({ clear: false, reason: 'no-seat-ran' })
  })

  test('a seat still working keeps the tag, even once the evidence is in', () => {
    expect(decideTagClear(facts({ seatLive: true }))).toEqual({ clear: false, reason: 'seat-still-running' })
  })

  // Ordering, pinned: a live seat is reported as live rather than as missing
  // evidence, because those two read completely differently to a human.
  test('a live seat outranks the evidence test', () => {
    expect(decideTagClear(facts({ seatLive: true, workLanded: false }))).toEqual({
      clear: false,
      reason: 'seat-still-running',
    })
  })

  test("an untagged card is not the drain's business", () => {
    expect(decideTagClear(facts({ tagged: false }))).toEqual({ clear: false, reason: 'not-tagged' })
  })
})

describe('clearCardTag', () => {
  const STORE = {} as unknown as ConversationStore

  /** A board that answers `get` from a fixture and records the patch. */
  function board(task: ProjectTask | null, updateOk = true) {
    const ops: Array<{ op: string; patch?: { tags?: string[] } }> = []
    const call = ((_s: ConversationStore, _p: string, op: { op: string; patch?: { tags?: string[] } }) => {
      ops.push(op)
      if (op.op === 'get') return Promise.resolve({ ok: true, task })
      return Promise.resolve({ ok: updateOk })
    }) as unknown as CallBoard
    return { call, ops }
  }

  const task = (tags: string[]): ProjectTask => ({ ...card('c', { tags }), body: '' })

  test('drops the one tag and keeps every other', async () => {
    const b = board(task([TAG, 'ready', 'epic']))
    expect(await clearCardTag(b.call, STORE, 'claude://p', 'c', TAG)).toBe(true)
    expect(b.ops.at(-1)?.patch?.tags).toEqual(['ready', 'epic'])
  })

  /**
   * THE RE-READ IS THE POINT. Minutes pass between the scan that selected the
   * card and this write; patching a remembered tag list would silently delete a
   * tag somebody added in between.
   */
  test('reads the card before it patches it', async () => {
    const b = board(task([TAG]))
    await clearCardTag(b.call, STORE, 'claude://p', 'c', TAG)
    expect(b.ops.map(o => o.op)).toEqual(['get', 'update'])
  })

  test('a card that already lost the tag is a success with no write', async () => {
    const b = board(task(['ready']))
    expect(await clearCardTag(b.call, STORE, 'claude://p', 'c', TAG)).toBe(true)
    expect(b.ops.map(o => o.op)).toEqual(['get'])
  })

  test('a card that cannot be read is a failure, not a silent success', async () => {
    const b = board(null)
    expect(await clearCardTag(b.call, STORE, 'claude://p', 'c', TAG)).toBe(false)
  })

  test('a refused write is reported as one', async () => {
    const b = board(task([TAG]), false)
    expect(await clearCardTag(b.call, STORE, 'claude://p', 'c', TAG)).toBe(false)
  })
})

describe('drainTag', () => {
  /** A drain over a fixed verdict per card, recording every write. */
  function run(cards: readonly ProjectTaskMeta[], evidence: (c: ProjectTaskMeta) => TagClearInput, ok = true) {
    const untagged: string[] = []
    const lines: string[] = []
    return {
      untagged,
      lines,
      report: drainTag(TAG, {
        cards,
        evidence,
        untag: async slug => {
          untagged.push(slug)
          return ok
        },
        log: l => lines.push(l),
      }),
    }
  }

  test('clears only the cards whose work landed', async () => {
    const h = run([card('landed'), card('killed')], c => facts({ workLanded: c.slug === 'landed' }))
    const report = await h.report
    expect(h.untagged).toEqual(['landed'])
    expect(report.cleared).toEqual(['landed'])
    expect(report.kept).toEqual([{ slug: 'killed', reason: 'no-evidence' }])
  })

  // Every clear is a mutation of somebody's card. It is the line a human greps
  // when a tag they applied is suddenly gone, so it names the card and the tag.
  test('every clear says so, naming the card and the tag', async () => {
    const h = run([card('landed')], () => facts())
    await h.report
    expect(h.lines.some(l => l.includes('landed') && l.includes(TAG))).toBe(true)
  })

  test('a kept card is not logged every tick', async () => {
    const h = run([card('killed')], () => facts({ workLanded: false }))
    await h.report
    expect(h.lines).toEqual([])
  })

  /** The board refusing a write is not a clear. The card stays tagged, the next
   *  pass tries again, and the failure is loud rather than counted as success. */
  test('a write the board refused lands in `failed`, not in `cleared`', async () => {
    const h = run([card('landed')], () => facts(), false)
    const report = await h.report
    expect(report.cleared).toEqual([])
    expect(report.failed).toEqual(['landed'])
    expect(h.lines.some(l => l.includes('could NOT drop'))).toBe(true)
  })

  test('a card that never carried the tag is neither cleared nor reported kept', async () => {
    const h = run([card('other', { tags: ['ready'] })], () => facts({ tagged: false }))
    const report = await h.report
    expect(report).toEqual({ cleared: [], kept: [], failed: [] })
  })

  // Sentinel round trips, one at a time -- a backlog fired at once is how one
  // board's RPC budget becomes N.
  test('writes are sequential, never fired in parallel', async () => {
    let inFlight = 0
    let overlapped = false
    await drainTag(TAG, {
      cards: [card('a'), card('b'), card('c')],
      evidence: () => facts(),
      untag: async () => {
        inFlight += 1
        if (inFlight > 1) overlapped = true
        await Promise.resolve()
        inFlight -= 1
        return true
      },
      log: () => {},
    })
    expect(overlapped).toBe(false)
  })
})
