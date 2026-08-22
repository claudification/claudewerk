import { beforeEach, describe, expect, test } from 'bun:test'
import { acknowledgedCardIds } from '../shared/epic-log'
import type { EpicLaunchTag, EpicLogEntry } from '../shared/epic-run-types'
import type { Conversation } from '../shared/protocol'
import { SCANNER_IDS } from '../shared/scanner-ids'
import { noteArmedEpic, resetArmedEpics } from './epic-registry'
import {
  epicsToWatch,
  generationMismatch,
  groupEpicConversations,
  isReservedScannerLane,
  lostOverseer,
  MAX_LAUNCH_ATTEMPTS,
  unacknowledgedCards,
  unacknowledgedFailedLegs,
} from './epic-sweep'
import { buildOverseerReaper, NEVER_REAPED, OVERSEER_SILENCE_MS, type Reaper } from './epic-vitality'

let n = 0
function conv(tag: EpicLaunchTag | undefined, live: boolean, output = true): Conversation & { __live: boolean } {
  n += 1
  return {
    id: `conv_${n}`,
    project: 'claude://s/p',
    ...(tag ? { launchConfig: { epic: tag } } : {}),
    __live: live,
    __output: output,
  } as unknown as Conversation & { __live: boolean }
}
const isLive = (c: Conversation) => (c as unknown as { __live: boolean }).__live
const producedOutput = (c: Conversation) => (c as unknown as { __output: boolean }).__output

/** The tag only carries identity; liveness is the second arg to `conv()`. */
const impl = (cardId: string, gen = 1): EpicLaunchTag & never =>
  ({ epicId: 'e1', role: 'implementer', cardId, gen }) as never
const overseer = (gen = 1): EpicLaunchTag & never => ({ epicId: 'e1', role: 'overseer', gen }) as never
const verifier = (cardId: string, gen = 1): EpicLaunchTag & never =>
  ({ epicId: 'e1', role: 'verifier', cardId, gen }) as never

function entry(kind: EpicLogEntry['kind'], cardId?: string): EpicLogEntry {
  return { ts: '', kind, convId: 'c', ...(cardId ? { cardId } : {}), body: '' }
}

describe('groupEpicConversations', () => {
  test('conversations with no epic tag are ignored entirely', () => {
    expect(groupEpicConversations([conv(undefined, true)], isLive).size).toBe(0)
  })

  test('a live implementer is in flight; a dead one has settled', () => {
    const group = groupEpicConversations([conv(impl('t1'), true), conv(impl('t2'), false)], isLive).get('e1')
    expect(group?.inFlight).toEqual(['t1'])
    expect(group?.settled).toEqual(['t2'])
  })

  test('a RETRIED card is in flight, not settled -- the dead first attempt must not settle it', () => {
    // Same card, two conversations: the crashed original and the live retry.
    const group = groupEpicConversations([conv(impl('t1'), false), conv(impl('t1'), true)], isLive).get('e1')
    expect(group?.inFlight).toEqual(['t1'])
    expect(group?.settled).toEqual([])
  })

  test('order of conversations does not change the verdict', () => {
    const group = groupEpicConversations([conv(impl('t1'), true), conv(impl('t1'), false)], isLive).get('e1')
    expect(group?.inFlight).toEqual(['t1'])
  })

  test('a live verifier is reported in its OWN lane, not just the combined one', () => {
    const group = groupEpicConversations([conv(verifier('t1'), true)], isLive).get('e1')
    expect(group?.inVerify).toEqual(['t1'])
    expect(group?.inFlight).toEqual(['t1'])
  })

  test('a DEAD verifier leaves the verify lane, so the card can be re-verified', () => {
    const group = groupEpicConversations([conv(verifier('t1'), false)], isLive).get('e1')
    expect(group?.inVerify).toEqual([])
    expect(group?.settled).toEqual(['t1'])
  })

  /** The lane must be role-scoped or it is just `inFlight` under another name --
   *  and an implementer keeping a card out of the verify lane would strand the
   *  verdict for as long as the implementer ran. */
  test('a live IMPLEMENTER never lands in the verify lane', () => {
    const group = groupEpicConversations([conv(impl('t1'), true)], isLive).get('e1')
    expect(group?.inVerify).toEqual([])
    expect(group?.inFlight).toEqual(['t1'])
  })

  test('a live overseer is reported; a dead one is not', () => {
    expect(groupEpicConversations([conv(overseer(), true)], isLive).get('e1')?.overseerAlive).toBe(true)
    expect(groupEpicConversations([conv(overseer(), false)], isLive).get('e1')?.overseerAlive).toBe(false)
  })

  test('the overseer never appears in inFlight -- it holds no card', () => {
    const group = groupEpicConversations([conv(overseer(), true), conv(impl('t1'), true)], isLive).get('e1')
    expect(group?.inFlight).toEqual(['t1'])
  })

  test('two epics group separately', () => {
    const other = { epicId: 'e2', role: 'implementer', cardId: 'x1', gen: 1 } as never
    const groups = groupEpicConversations([conv(impl('t1'), true), conv(other, true)], isLive)
    expect(groups.size).toBe(2)
    expect(groups.get('e2')?.inFlight).toEqual(['x1'])
  })

  test('the highest generation seen is reported for diagnostics', () => {
    const groups = groupEpicConversations([conv(impl('t1', 3), true), conv(impl('t2', 7), true)], isLive)
    expect(groups.get('e1')?.maxGenSeen).toBe(7)
  })
})

/**
 * THE 2026-08-21 INCIDENT: A DEAD SEAT THAT NEVER SETTLED.
 *
 * `runner-run-delete-verb` was dispatched at 16:38:35Z on `epic-project-runner`.
 * Twelve minutes later the engine still counted it in flight: no `completion`
 * entry existed, the card sat at `open`, and generation 7 planned against
 * `dispatch (1)` of a ceiling of 2 with two cards "HELD BACK by the concurrency
 * ceiling". The second slot was being held for a conversation that had been dead
 * the whole time.
 *
 * The mechanism is `werkLiveness`: live unless the row says `ended`. Nothing in
 * the store ever writes `ended` on a clock, so a seat whose end was never
 * recorded reads live forever, and the slot is held by a BELIEF with no expiry.
 */
describe('a seat that dies without its end being recorded is reaped', () => {
  /** Every seat here CLAIMS to be live -- that is the whole failure. */
  const reapSeat: Reaper = c => (c.id === 'conv_dead' ? { silentForMs: 12 * 60_000 } : null)
  const reaped = { seat: reapSeat, overseer: NEVER_REAPED }
  const named = (tag: EpicLaunchTag, id: string, output = true) =>
    // `status: 'idle'` is the shape the incident actually wore: the maintenance
    // pass demotes `active` -> `idle` on silence and stops there, so a seat whose
    // end was never recorded sits at `idle` for the life of the broker.
    ({ ...conv(tag, true, output), id, status: 'idle', lastActivity: 0 }) as unknown as Conversation

  const group = (convs: Conversation[]) => groupEpicConversations(convs, isLive, producedOutput, reaped).get('e1')

  test('THE LEAK: without a reaper the card stays in flight forever, holding its slot', () => {
    const g = groupEpicConversations([named(impl('t1'), 'conv_dead')], isLive, producedOutput).get('e1')
    expect(g?.inFlight).toEqual(['t1'])
    expect(g?.settled).toEqual([])
  })

  test('with the reaper the card leaves the in-flight lane -- the slot comes back', () => {
    expect(group([named(impl('t1'), 'conv_dead')])?.inFlight).toEqual([])
  })

  test('and it SETTLES, so the beat acknowledges it instead of rediscovering it forever', () => {
    expect(group([named(impl('t1'), 'conv_dead')])?.settled).toEqual(['t1'])
  })

  /** The whole point of the lane: a settle caused by a death must be tellable
   *  apart from a settle caused by a finish. */
  test('the reaping is reported with the evidence a human can check', () => {
    const g = group([named(impl('t1'), 'conv_dead')])
    expect(g?.abandonedSeats).toEqual([
      {
        cardId: 't1',
        convId: 'conv_dead',
        role: 'implementer',
        gen: 1,
        lastActivity: 0,
        silentForMs: 12 * 60_000,
        status: 'idle',
      },
    ])
  })

  test('an ordinary finished seat is NOT reported as abandoned', () => {
    const g = groupEpicConversations([conv(impl('t1'), false)], isLive, producedOutput, reaped).get('e1')
    expect(g?.abandonedSeats).toEqual([])
    expect(g?.settled).toEqual(['t1'])
  })

  test('a reaped VERIFIER leaves the verify lane too, or the verdict is never rewritten', () => {
    const g = group([named(verifier('t1'), 'conv_dead')])
    expect(g?.inVerify).toEqual([])
    expect(g?.abandonedSeats[0]?.role).toBe('verifier')
  })

  /** The OR-fold still rules. A reaped predecessor must not settle a card whose
   *  retry is genuinely running, or the engine would strand live work. */
  test('a reaped seat does NOT settle a card that has a live retry', () => {
    const g = group([named(impl('t1'), 'conv_dead'), named(impl('t1'), 'conv_live')])
    expect(g?.inFlight).toEqual(['t1'])
    expect(g?.settled).toEqual([])
  })

  /** A seat that attached, said nothing and vanished never started -- it is a
   *  failed launch, and folding it into `settled` is the 2026-08-20 bug. */
  test('a reaped seat that produced NOTHING is a failed leg, not a completion', () => {
    const g = group([named(impl('t1'), 'conv_dead', false)])
    expect(g?.settled).toEqual([])
    expect(g?.failedLegs).toHaveLength(1)
  })

  /**
   * BOUNDED ON PURPOSE. An overseer stuck at a non-`ended` status holds
   * `overseerAlive`, which holds the WHOLE beat, and unfreezing it means granting
   * the lease to a second overseer -- a full generation if it is wrong. That is
   * `epic-overseer-seat-never-reaped`, not this card.
   */
  test('the overseer is deliberately NOT reaped', () => {
    const g = group([named(overseer(), 'conv_dead')])
    expect(g?.overseerAlive).toBe(true)
    expect(g?.abandonedSeats).toEqual([])
  })
})

/**
 * THE 2026-08-20 INCIDENT, engine half.
 *
 * A verifier spawn died at `exit=1` after 1209ms -- before CC wrote a single
 * transcript entry. Every backing conversation for the card was then dead, so
 * the sweep folded it into `settled`, the beat wrote a `completion` entry
 * saying the card had reached a terminal state, and woke a fresh overseer
 * generation to consider a verdict that nobody had written. Every subsequent
 * sweep did it again.
 *
 * A settle whose conversation produced zero output is not a settle. It is a
 * failed launch, and the two are distinguishable from exactly one fact: whether
 * anything came out.
 */
describe('a launch that produced nothing is not a completed leg', () => {
  const group = (convs: Conversation[]) => groupEpicConversations(convs, isLive, producedOutput).get('e1')

  test('a dead conversation with ZERO output does not settle its card', () => {
    const g = group([conv(verifier('t1'), false, false)])
    expect(g?.settled).toEqual([])
    expect(g?.inFlight).toEqual([])
  })

  test('the failed leg is reported by card, conversation and role -- enough for a baton entry', () => {
    const c = conv(verifier('t1'), false, false)
    expect(group([c])?.failedLegs).toEqual([{ cardId: 't1', convId: c.id, role: 'verifier', gen: 1 }])
  })

  test('a dead conversation that DID produce output settles, exactly as before', () => {
    const g = group([conv(impl('t1'), false, true)])
    expect(g?.settled).toEqual(['t1'])
    expect(g?.failedLegs).toEqual([])
  })

  test('one silent death alongside one real run still settles -- the real leg did the work', () => {
    const g = group([conv(impl('t1'), false, false), conv(impl('t1'), false, true)])
    expect(g?.settled).toEqual(['t1'])
    // Still reported: the dead silent leg happened, and the baton says so.
    expect(g?.failedLegs).toHaveLength(1)
  })

  test('a LIVE conversation with no output YET is not a failed leg -- it is just young', () => {
    const g = group([conv(impl('t1'), true, false)])
    expect(g?.failedLegs).toEqual([])
    expect(g?.inFlight).toEqual(['t1'])
  })

  test('an overseer that died silently is nobody’s card, and is not reported', () => {
    expect(group([conv(overseer(), false, false)])?.failedLegs).toEqual([])
  })

  test('with no output predicate the old behaviour stands -- a dead leg settles', () => {
    expect(groupEpicConversations([conv(impl('t1'), false, false)], isLive).get('e1')?.settled).toEqual(['t1'])
  })
})

/**
 * THE BOUND ON THE RETRY PATH.
 *
 * Leaving a failed launch dispatchable is right once per attempt and ruinous
 * without a ceiling. Generation 2 of `epic-the-wall-ii` wrote THIRTEEN
 * `dispatch` entries for one card; thirteen seats died; the log recorded
 * thirteen dispatches and zero failures. A fix that only stopped the false
 * settle would have turned that into thirteen retries a beat apart, forever.
 */
describe('a card whose seats keep dying stops being retried', () => {
  const dead = (n: number) => Array.from({ length: n }, () => conv(verifier('t1'), false, false))
  const group = (convs: Conversation[]) => groupEpicConversations(convs, isLive, producedOutput).get('e1')

  test('the bound is three attempts', () => {
    expect(MAX_LAUNCH_ATTEMPTS).toBe(3)
  })

  test('two failures still leave the card retryable -- a transient death must not strand it', () => {
    const g = group(dead(2))
    expect(g?.unspawnable).toEqual([])
    expect(g?.failedLegs).toHaveLength(2)
  })

  test('the third failure marks it unspawnable', () => {
    expect(group(dead(3))?.unspawnable).toEqual(['t1'])
  })

  test('and it never lands in settled -- being given up on is not being done', () => {
    const g = group(dead(4))
    expect(g?.settled).toEqual([])
    expect(g?.inFlight).toEqual([])
    expect(g?.unspawnable).toEqual(['t1'])
  })

  test('a card that eventually PRODUCED something is never unspawnable, however many seats died', () => {
    const g = group([...dead(5), conv(verifier('t1'), false, true)])
    expect(g?.unspawnable).toEqual([])
    expect(g?.settled).toEqual(['t1'])
  })

  test('a live retry outranks the bound -- do not give up on work that is running', () => {
    const g = group([...dead(3), conv(verifier('t1'), true, false)])
    expect(g?.unspawnable).toEqual([])
    expect(g?.inFlight).toEqual(['t1'])
  })

  test('the bound is per card, not per epic', () => {
    const g = group([...dead(3), conv(impl('t2'), false, false)])
    expect(g?.unspawnable).toEqual(['t1'])
  })
})

describe('unacknowledgedFailedLegs -- one baton entry per dead leg, not one per sweep', () => {
  const leg = (convId: string, cardId = 't1') => ({ cardId, convId, role: 'verifier' as const, gen: 1 })
  const failedEntry = (convId: string): EpicLogEntry => ({
    ts: '',
    kind: 'dispatch-failed',
    convId,
    cardId: 't1',
    body: '',
  })

  test('a leg the baton has never seen is reported', () => {
    expect(unacknowledgedFailedLegs([leg('c1')], [])).toEqual([leg('c1')])
  })

  test('a dispatch-failed entry for that CONVERSATION suppresses it', () => {
    expect(unacknowledgedFailedLegs([leg('c1')], [failedEntry('c1')])).toEqual([])
  })

  test('an entry for a different conversation does not suppress it -- a retry can fail too', () => {
    expect(unacknowledgedFailedLegs([leg('c2')], [failedEntry('c1')])).toEqual([leg('c2')])
  })

  test('a COMPLETION entry does not suppress it -- that is the confusion this exists to end', () => {
    expect(unacknowledgedFailedLegs([leg('c1')], [entry('completion', 't1')])).toEqual([leg('c1')])
  })
})

describe('acknowledgedCardIds -- which cards the log has ever settled', () => {
  test('a completion entry acknowledges its card', () => {
    expect(acknowledgedCardIds([entry('completion', 't1')])).toEqual(['t1'])
  })

  test('a verdict entry acknowledges it too', () => {
    expect(acknowledgedCardIds([entry('verdict', 't1')])).toEqual(['t1'])
  })

  test('a DISPATCH entry does NOT acknowledge -- it records a start, not an outcome', () => {
    expect(acknowledgedCardIds([entry('dispatch', 't1')])).toEqual([])
  })

  test('a cardless entry acknowledges nothing', () => {
    expect(acknowledgedCardIds([entry('completion')])).toEqual([])
  })
})

describe('unacknowledgedCards -- the standing question the wake is built on', () => {
  test('a settled card the log has never acknowledged comes back', () => {
    expect(unacknowledgedCards(['t1'], [])).toEqual(['t1'])
  })

  test('an acknowledged one does not', () => {
    expect(unacknowledgedCards(['t1'], ['t1'])).toEqual([])
  })

  test('an acknowledgement of a different card does not cover this one', () => {
    expect(unacknowledgedCards(['t1'], ['t2'])).toEqual(['t1'])
  })

  test('only the unacknowledged ones come back, in order', () => {
    expect(unacknowledgedCards(['t1', 't2', 't3'], acknowledgedCardIds([entry('completion', 't1')]))).toEqual([
      't2',
      't3',
    ])
  })

  /**
   * THE DEFECT, AT THE UNIT LEVEL. Kept deliberately, and it is not a test of
   * this function -- the function is right, and was right the whole time.
   *
   * The argument was wrong: the beat fed it the acknowledgement set folded from
   * the sentinel's 20-entry PROMPT TAIL, so a run with more settled cards than
   * that re-discovered every card whose acknowledgement had scrolled out of the
   * window. Below, all 25 are acknowledged in the log and 5 still come back.
   * That is a call site bug a unit test of `unacknowledgedCards` can never fail
   * on, which is why the test that guards the fix lives at the seam
   * (epic-executor.test.ts, 'against the real sentinel seam').
   */
  test('folding a TRUNCATED window re-discovers the settles that scrolled out of it', () => {
    const settled = Array.from({ length: 25 }, (_, i) => `t${i + 1}`)
    const wholeLog = settled.map(id => entry('completion', id))
    const promptTail = wholeLog.slice(-20)

    expect(unacknowledgedCards(settled, acknowledgedCardIds(promptTail))).toHaveLength(5)
    expect(unacknowledgedCards(settled, acknowledgedCardIds(wholeLog))).toEqual([])
  })
})

/**
 * THE OVERSEER WHOSE END WAS NEVER RECORDED.
 *
 * `werkLiveness` reads "live unless the row says `ended`", and nothing writes
 * `ended` on a clock -- so a supervisor whose agent host died sits at `idle`
 * forever, holds `overseerAlive`, and `guardBeat` returns `overseer alive at gen
 * N; holding the beat` every 45 seconds for the life of the broker. Nothing
 * dispatches, nothing verifies, nothing parks, and the line is indistinguishable
 * from the healthy case it exists to describe.
 *
 * The reaper is the second opinion. These tests drive the FOLD; the rule itself
 * is `epic-vitality.test.ts`.
 */
describe('an overseer whose end was never recorded is reaped', () => {
  const T0 = 1_700_000_000_000
  /** A seat the registry still calls live: `idle`, no recorded end, a
   *  `lastActivity` the test moves around. */
  const seat = (lastActivity: number, gen = 4): Conversation =>
    ({
      id: 'conv_overseer',
      project: 'claude://s/p',
      status: 'idle',
      lastActivity,
      launchConfig: { epic: { epicId: 'e1', role: 'overseer', gen } },
    }) as unknown as Conversation

  /** The registry says LIVE for every one of these -- that is the lie. */
  const registryClaimsLive = () => true
  const reaperAt = (nowMs: number, socket = false) => buildOverseerReaper({ hasSocket: () => socket, now: () => nowMs })

  const fold = (conv: Conversation, nowMs: number, socket = false) =>
    groupEpicConversations([conv], registryClaimsLive, undefined, {
      seat: NEVER_REAPED,
      overseer: reaperAt(nowMs, socket),
    }).get('e1')

  test('a silent, socketless overseer stops holding `overseerAlive`', () => {
    const group = fold(seat(T0), T0 + OVERSEER_SILENCE_MS + 1)
    expect(group?.overseerAlive).toBe(false)
  })

  /**
   * THE HALF THAT IS NOT COSMETIC. `liveOverseers` is `holderAlive`'s input at
   * the lease CAS, so reaping `overseerAlive` alone would unfreeze `guardBeat`
   * only for the replacement wake to be refused by a holder the same fold had
   * just declared dead -- the run frozen by a second mechanism instead of the
   * first.
   */
  test('and leaves `liveOverseers` in the SAME pass, so the lease CAS agrees', () => {
    const group = fold(seat(T0), T0 + OVERSEER_SILENCE_MS + 1)
    expect(group?.liveOverseers).toEqual([])
  })

  test('the reap is reported with its evidence, not merely applied', () => {
    const group = fold(seat(T0, 7), T0 + OVERSEER_SILENCE_MS + 60_000)
    expect(group?.abandonedOverseers).toEqual([
      {
        convId: 'conv_overseer',
        gen: 7,
        lastActivity: T0,
        silentForMs: OVERSEER_SILENCE_MS + 60_000,
        status: 'idle',
      },
    ])
  })

  test('a working overseer is never reaped, however long its turn takes -- recent activity', () => {
    const group = fold(seat(T0 + OVERSEER_SILENCE_MS * 9), T0 + OVERSEER_SILENCE_MS * 9 + 1_000)
    expect(group?.overseerAlive).toBe(true)
    expect(group?.liveOverseers).toEqual(['conv_overseer'])
    expect(group?.abandonedOverseers).toEqual([])
  })

  test('nor one holding a socket, silent or not', () => {
    const group = fold(seat(T0), T0 + OVERSEER_SILENCE_MS * 100, true)
    expect(group?.overseerAlive).toBe(true)
    expect(group?.abandonedOverseers).toEqual([])
  })

  /** An overseer that ENDED properly is dead by `werkLiveness` and never reaches
   *  the reaper. Reporting it here would wake a replacement for a supervisor that
   *  simply went home -- once per sweep, forever. */
  test('an overseer that ended cleanly is dead but NOT reported as abandoned', () => {
    const group = groupEpicConversations([seat(T0)], () => false, undefined, {
      seat: NEVER_REAPED,
      overseer: reaperAt(T0 + OVERSEER_SILENCE_MS + 1),
    }).get('e1')
    expect(group?.overseerAlive).toBe(false)
    expect(group?.abandonedOverseers).toEqual([])
  })

  test('with no reaper wired the fold behaves exactly as it always did', () => {
    const group = groupEpicConversations([seat(T0)], registryClaimsLive).get('e1')
    expect(group?.overseerAlive).toBe(true)
    expect(group?.abandonedOverseers).toEqual([])
  })

  const implSeat = {
    id: 'conv_impl',
    project: 'claude://s/p',
    status: 'idle',
    lastActivity: T0,
    launchConfig: { epic: { epicId: 'e1', role: 'implementer', cardId: 't1', gen: 4 } },
  } as unknown as Conversation

  /**
   * THE TWO LANES DO NOT REACH EACH OTHER, and this is the pair of assertions
   * that says so. The two reapers share a structural type, so nothing but the
   * field name distinguishes them at a call site -- which is why the fold takes a
   * named pair and why both directions are asserted here rather than one.
   *
   * Reaping the wrong lane is not a cosmetic slip in either direction: an
   * overseer's fifteen-minute grace applied to a card seat strands a card, and a
   * card seat's ten-minute grace applied to the overseer wakes a second
   * supervisor five minutes early.
   */
  test('the OVERSEER reaper is never asked of a card seat', () => {
    const group = groupEpicConversations([implSeat], registryClaimsLive, undefined, {
      seat: NEVER_REAPED,
      overseer: reaperAt(T0 + OVERSEER_SILENCE_MS * 100),
    }).get('e1')
    expect(group?.inFlight).toEqual(['t1'])
    expect(group?.abandonedSeats).toEqual([])
  })

  test('and the SEAT reaper is never asked of the overseer', () => {
    const group = groupEpicConversations([seat(T0)], registryClaimsLive, undefined, {
      seat: reaperAt(T0 + OVERSEER_SILENCE_MS * 100),
      overseer: NEVER_REAPED,
    }).get('e1')
    expect(group?.overseerAlive).toBe(true)
    expect(group?.abandonedOverseers).toEqual([])
  })
})

/**
 * WHY THE WAKE IS KEYED ON THE LEASE HOLDER.
 *
 * `abandonedOverseers` is re-derived from a registry that never forgets, so it
 * never empties -- a wake fired from the lane itself would fire again every 45
 * seconds for the life of the broker. The lease moves; the lane does not.
 */
describe('lostOverseer', () => {
  const dead = { convId: 'conv_dead', gen: 3, lastActivity: 0, silentForMs: 1, status: 'idle' as const }
  const group = (over = {}) =>
    ({ abandonedOverseers: [dead], ...over }) as unknown as Parameters<typeof lostOverseer>[0]
  const lease = (convId: string) => ({ convId, gen: 3, at: '' })

  test('the holder is one of the corpses -- the fact the replacement wake is fired from', () => {
    expect(lostOverseer(group(), lease('conv_dead'))).toEqual(dead)
  })

  test('a DIFFERENT holder is not: an ex-overseer that died two generations ago is not news', () => {
    expect(lostOverseer(group(), lease('conv_current'))).toBeNull()
  })

  test('a released lease holds nothing, so nothing was lost', () => {
    expect(lostOverseer(group(), lease(''))).toBeNull()
    expect(lostOverseer(group(), null)).toBeNull()
  })

  test('no corpses at all', () => {
    expect(lostOverseer(group({ abandonedOverseers: [] }), lease('conv_dead'))).toBeNull()
  })
})

describe('generationMismatch', () => {
  const group = {
    epicId: 'e1',
    project: '',
    inFlight: [],
    inVerify: [],
    overseerAlive: false,
    liveOverseers: [],
    abandonedOverseers: [],
    settled: [],
    failedLegs: [],
    abandonedSeats: [],
    unspawnable: [],
    convIds: [],
    maxGenSeen: 5,
  }

  test('agreement is silent', () => {
    expect(generationMismatch(group, 5)).toBeNull()
  })

  test('a run file behind its conversations is reported -- spawns racing the lease', () => {
    expect(generationMismatch(group, 3)).toContain('racing the lease')
  })

  test('a run file AHEAD is normal (the lease just advanced) and stays silent', () => {
    expect(generationMismatch(group, 9)).toBeNull()
  })
})

describe('a reserved scanner lane is never an epic', () => {
  /** A seat stamped with a scanner's own id -- what `planImplementerSpawn` emits
   *  for a card that belongs to no epic. `work-order` is the first such lane. */
  const lane = (cardId: string, epicId = 'work-order'): EpicLaunchTag & never =>
    ({ epicId, role: 'implementer', cardId, gen: 1 }) as never

  const watched = (convs: Conversation[]) => epicsToWatch(convs, isLive, producedOutput).map(g => g.epicId)

  beforeEach(() => {
    resetArmedEpics()
  })

  test('every named scanner id is reserved, and an ordinary epic id is not', () => {
    for (const id of SCANNER_IDS) expect(isReservedScannerLane(id)).toBe(true)
    expect(isReservedScannerLane('epic-scanner-fabric')).toBe(false)
    // Substrings and near-misses are not lanes -- the match is on the whole id.
    expect(isReservedScannerLane('work-order-2')).toBe(false)
    expect(isReservedScannerLane('')).toBe(false)
  })

  test('a RENAMED id stays reserved under its old spelling -- seats already wear it', () => {
    // The launch tag of every work-order seat dispatched before the singular
    // rename says `work-orders`, and a tag is written once and never rewritten.
    // Drop the alias here and each of those becomes a phantom epic with no
    // `run.md`, beaten every 45s for the life of the broker.
    expect(isReservedScannerLane('work-orders')).toBe(true)
    expect(watched([conv(lane('t1', 'work-orders'), false)])).toEqual([])
  })

  test('a LIVE work-order seat is invisible to the sweep', () => {
    expect(watched([conv(lane('t1'), true)])).toEqual([])
  })

  test('and an ENDED one stays invisible -- the registry keeps it forever', () => {
    // The phantom this exists to kill: the group survives the seat, so without
    // the filter the sweep beats `work-order` every 45s for the life of the
    // broker and logs "armed but nothing is on disk for it" each time.
    expect(watched([conv(lane('t1'), false)])).toEqual([])
  })

  test('real epics in the same tick are untouched', () => {
    expect(watched([conv(lane('t1'), false), conv(impl('t2'), true)])).toEqual(['e1'])
  })

  test('an ARMED entry carrying a scanner id is dropped too, not just a tagged conversation', () => {
    // `epicsToWatch` unions two sources; filtering one of them would leave the
    // hole open on the other.
    noteArmedEpic('claude://s/p', 'work-order')
    noteArmedEpic('claude://s/p', 'e1')
    expect(watched([]).sort()).toEqual(['e1'])
  })

  test('every reserved id is filtered, not just the one lane in use today', () => {
    expect(watched(SCANNER_IDS.map(id => conv(lane('t1', id), true)))).toEqual([])
  })

  test('the raw grouping still SEES the lane -- epic-inspect needs its seats', () => {
    const groups = groupEpicConversations([conv(lane('t1'), true)], isLive, producedOutput)
    expect(groups.get('work-order')?.inFlight).toEqual(['t1'])
  })
})
