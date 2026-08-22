/**
 * Every branch of the sweep, with no broker, no sentinel, no filesystem and no
 * CC process -- the property the card was written around. The whole harness is
 * the `deps()` builder below.
 */

import { describe, expect, test } from 'bun:test'
import { runScan } from '../broker/scanners/scanner'
import {
  type BoardSweepDeps,
  boardSnapshot,
  boardSweepScanner,
  cardsBeingWorked,
  DEFAULT_COLD_AFTER_DAYS,
  daysSince,
  type SweepCard,
  sweepBoard,
} from './board-sweep'
import type { DuplicateJudge } from './board-sweep-duplicates'
import type { Proposal } from './board-sweep-proposals'
import type { PromiseRow } from './promise-ledger'
import type { Conversation } from './protocol'
import type { TaskStatus } from './task-statuses'

const NOW = Date.parse('2026-08-21T00:00:00Z')
const DAY = 86_400_000

function card(slug: string, over: Partial<SweepCard> = {}): SweepCard {
  return {
    slug,
    status: 'open' as TaskStatus,
    title: `card ${slug}`,
    tags: [],
    refs: [],
    created: new Date(NOW - DAY).toISOString(),
    mtime: 1_000,
    bodyPreview: `preview ${slug}`,
    ...over,
  }
}

function promise(id: string, over: Partial<PromiseRow> = {}): PromiseRow {
  return {
    id,
    status: 'open',
    title: `card ${id}`,
    agreed: '2026-08-01',
    conversation: null,
    session: null,
    asked: 'do the thing',
    closes: ['abc1234'],
    preLedger: false,
    inferred: false,
    commits: [{ sha: 'abc1234', exists: true, onMain: true }],
    verdict: 'delivered',
    ...over,
  }
}

function conv(cardId: string, seat = '1'): Conversation {
  return {
    id: `conv_${cardId}_${seat}`,
    project: 'claude://s/p',
    status: 'running',
    launchConfig: { epic: { epicId: 'e1', role: 'werk-worker', gen: 1, cardId } },
  } as unknown as Conversation
}

interface Harness {
  deps: BoardSweepDeps
  log: string[]
}

function harness(over: Partial<BoardSweepDeps> & { convs?: Conversation[] } = {}): Harness {
  const log: string[] = []
  const convs = over.convs ?? []
  const deps: BoardSweepDeps = {
    getAllConversations: () => convs,
    isLive: () => true,
    log: (line: string) => log.push(line),
    now: () => NOW,
    getCards: () => [],
    getPromises: () => [],
    head: () => 'HEAD1',
    lastSnapshot: () => null,
    ...over,
  }
  return { deps, log }
}

/** Every refusal bucket a card landed in. */
function buckets(refused: readonly { unit: string; bucket: string }[], unit: string): string[] {
  return refused.filter(r => r.unit === unit).map(r => r.bucket)
}

function kinds(proposals: readonly Proposal[]): string[] {
  return proposals.map(p => `${p.kind}:${p.card}`)
}

describe('the short-circuit', () => {
  test('an unchanged HEAD and board says "nothing moved" and does no work', async () => {
    const cards = [card('a', { status: 'inbox', created: '2020-01-01T00:00:00Z' })]
    const snapshot = boardSnapshot('HEAD1', cards)
    let judged = false
    const judge: DuplicateJudge = async () => {
      judged = true
      return []
    }
    const { deps } = harness({ getCards: () => cards, lastSnapshot: () => snapshot, judgeDuplicates: judge })

    const out = await sweepBoard(deps)
    expect(out.skipped).toBe(true)
    expect(out.proposals).toEqual([])
    expect(out.selected).toEqual([])
    expect(out.idleReason).toContain('nothing moved')
    expect(judged).toBe(false)
  })

  test('a first run has no previous snapshot and always sweeps', async () => {
    const cards = [card('a', { status: 'inbox', created: '2020-01-01T00:00:00Z' })]
    const { deps } = harness({ getCards: () => cards, lastSnapshot: () => null })
    const out = await sweepBoard(deps)
    expect(out.skipped).toBe(false)
    expect(kinds(out.proposals)).toEqual(['archive-cold:a'])
  })

  test('a moved HEAD with an unchanged board still sweeps -- promises resolve against git', async () => {
    const cards = [card('a', { status: 'inbox', created: '2020-01-01T00:00:00Z' })]
    const { deps } = harness({
      getCards: () => cards,
      head: () => 'HEAD2',
      lastSnapshot: () => boardSnapshot('HEAD1', cards),
    })
    expect((await sweepBoard(deps)).skipped).toBe(false)
  })

  test('the snapshot moves when a card is DELETED, which touches no surviving mtime', () => {
    const a = card('a')
    const b = card('b')
    expect(boardSnapshot('HEAD1', [a, b])).not.toBe(boardSnapshot('HEAD1', [a]))
  })

  test('the snapshot moves when any card is written', () => {
    expect(boardSnapshot('HEAD1', [card('a', { mtime: 1 })])).not.toBe(
      boardSnapshot('HEAD1', [card('a', { mtime: 2 })]),
    )
  })

  test('the sweep hands back the snapshot to feed the next run', async () => {
    const cards = [card('a')]
    const { deps } = harness({ getCards: () => cards })
    expect((await sweepBoard(deps)).snapshot).toBe(boardSnapshot('HEAD1', cards))
  })
})

describe('promote-delivered', () => {
  test('a delivered promise on an unfiled card arrives TICKED, carrying its commits', async () => {
    const { deps } = harness({
      getCards: () => [card('a', { status: 'in-review' })],
      getPromises: () => [promise('a')],
    })
    const out = await sweepBoard(deps)
    const [p] = out.proposals
    expect(p.kind).toBe('promote-delivered')
    expect(p.checked).toBe(true)
    expect(p.kind === 'promote-delivered' && p.from).toBe('in-review')
    expect(p.kind === 'promote-delivered' && p.closes).toEqual(['abc1234'])
    expect(out.acted).toEqual(['a'])
  })

  test('a delivered promise on a card already done is refused, not re-proposed', async () => {
    const { deps } = harness({
      getCards: () => [card('a', { status: 'done' })],
      getPromises: () => [promise('a', { status: 'done' })],
    })
    const out = await sweepBoard(deps)
    expect(out.proposals).toEqual([])
    expect(buckets(out.refused, 'a')).toEqual(['already-filed'])
  })

  test('an archived card is filed too -- promoting it to done would be a lane reversal', async () => {
    const { deps } = harness({
      getCards: () => [card('a', { status: 'archived' })],
      getPromises: () => [promise('a', { status: 'archived' })],
    })
    expect(buckets((await sweepBoard(deps)).refused, 'a')).toEqual(['already-filed'])
  })

  test('an undelivered verdict is not a candidate at all -- it is the ledger’s row, not ours', async () => {
    for (const verdict of ['not-started', 'commit-missing', 'not-on-main', 'unverifiable', 'pre-ledger'] as const) {
      const { deps } = harness({ getCards: () => [card('a')], getPromises: () => [promise('a', { verdict })] })
      const out = await sweepBoard(deps)
      expect(out.selected).toEqual([])
      expect(out.proposals).toEqual([])
    }
  })

  test('a promise naming a card that is not on the board is skipped, not guessed at', async () => {
    const { deps } = harness({ getCards: () => [card('a')], getPromises: () => [promise('ghost')] })
    const out = await sweepBoard(deps)
    expect(out.selected).toEqual([])
  })
})

describe('archive-cold', () => {
  test('an inbox card past the threshold arrives TICKED', async () => {
    const created = new Date(NOW - 45 * DAY).toISOString()
    const { deps } = harness({ getCards: () => [card('a', { status: 'inbox', created })] })
    const out = await sweepBoard(deps)
    const [p] = out.proposals
    expect(p.kind).toBe('archive-cold')
    expect(p.checked).toBe(true)
    expect(p.kind === 'archive-cold' && p.ageDays).toBe(45)
  })

  test('exactly at the threshold is cold; one day short is not', async () => {
    const at = new Date(NOW - DEFAULT_COLD_AFTER_DAYS * DAY).toISOString()
    const short = new Date(NOW - (DEFAULT_COLD_AFTER_DAYS - 1) * DAY).toISOString()
    const { deps } = harness({
      getCards: () => [card('a', { status: 'inbox', created: at }), card('b', { status: 'inbox', created: short })],
    })
    const out = await sweepBoard(deps)
    expect(kinds(out.proposals)).toEqual(['archive-cold:a'])
    expect(buckets(out.refused, 'b')).toEqual(['not-cold-yet'])
  })

  test('the threshold is a knob', async () => {
    const created = new Date(NOW - 10 * DAY).toISOString()
    const { deps } = harness({ getCards: () => [card('a', { status: 'inbox', created })], coldAfterDays: 7 })
    expect(kinds((await sweepBoard(deps)).proposals)).toEqual(['archive-cold:a'])
  })

  test('a MISSING created is unknown, never old -- rule 2, and the whole board depends on it', async () => {
    const { deps } = harness({ getCards: () => [card('a', { status: 'inbox', created: '' })] })
    const out = await sweepBoard(deps)
    expect(out.proposals).toEqual([])
    expect(buckets(out.refused, 'a')).toEqual(['created-unknown'])
  })

  test('an unreadable created is unknown too, and says which', async () => {
    const { deps } = harness({ getCards: () => [card('a', { status: 'inbox', created: 'sometime last spring' })] })
    const out = await sweepBoard(deps)
    expect(buckets(out.refused, 'a')).toEqual(['created-unknown'])
    expect(out.refused[0].detail).toContain('sometime last spring')
  })

  test('inbox ONLY -- an ancient open card is not a cold candidate', async () => {
    const created = new Date(NOW - 400 * DAY).toISOString()
    for (const status of ['open', 'in-progress', 'in-review', 'done', 'archived'] as TaskStatus[]) {
      const { deps } = harness({ getCards: () => [card('a', { status, created })] })
      expect((await sweepBoard(deps)).selected).toEqual([])
    }
  })
})

describe('age comes from created and never from mtime', () => {
  test('an ancient card written one second ago is still cold', async () => {
    const created = new Date(NOW - 400 * DAY).toISOString()
    const { deps } = harness({ getCards: () => [card('a', { status: 'inbox', created, mtime: NOW })] })
    expect(kinds((await sweepBoard(deps)).proposals)).toEqual(['archive-cold:a'])
  })

  test('a fresh card whose file has not been touched in a year is NOT cold', async () => {
    const created = new Date(NOW - DAY).toISOString()
    const { deps } = harness({ getCards: () => [card('a', { status: 'inbox', created, mtime: NOW - 400 * DAY })] })
    const out = await sweepBoard(deps)
    expect(out.proposals).toEqual([])
    expect(buckets(out.refused, 'a')).toEqual(['not-cold-yet'])
  })
})

describe('a card with a live conversation is left alone', () => {
  test('rule 4 beats every other signal, and fires exactly once', async () => {
    const created = new Date(NOW - 400 * DAY).toISOString()
    const cards = [card('a', { status: 'inbox', created, deleteAt: '2020-01-01T00:00:00Z' })]
    const { deps } = harness({ getCards: () => cards, getPromises: () => [promise('a')], convs: [conv('a')] })
    const out = await sweepBoard(deps)
    expect(out.proposals).toEqual([])
    expect(buckets(out.refused, 'a')).toEqual(['live-conversation'])
  })

  test('a DEAD conversation on the card is no reason to withhold a proposal', async () => {
    const created = new Date(NOW - 400 * DAY).toISOString()
    const { deps } = harness({
      getCards: () => [card('a', { status: 'inbox', created })],
      convs: [conv('a')],
      isLive: () => false,
    })
    expect(kinds((await sweepBoard(deps)).proposals)).toEqual(['archive-cold:a'])
  })

  test('cardsBeingWorked OR-folds seats -- a dead retry predecessor cannot free a live card', () => {
    // The crashed first seat is listed FIRST, so a fold that overwrote instead of
    // OR-ing would read the live retry as finished.
    const live = cardsBeingWorked({
      getAllConversations: () => [conv('a', 'dead'), conv('a', 'live')],
      isLive: c => c.id === 'conv_a_live',
    })
    expect([...live]).toEqual(['a'])
  })

  test('a conversation with no card seat is ignored', () => {
    const bare = { id: 'c1', project: 'p', status: 'running' } as unknown as Conversation
    expect(cardsBeingWorked({ getAllConversations: () => [bare], isLive: () => true }).size).toBe(0)
  })
})

describe('note-delete-at', () => {
  test('an elapsed delete_at is SEEN -- unticked and not executable', async () => {
    const deleteAt = new Date(NOW - 3 * DAY).toISOString()
    const { deps } = harness({ getCards: () => [card('a', { deleteAt })] })
    const out = await sweepBoard(deps)
    const [p] = out.proposals
    expect(p.kind).toBe('note-delete-at')
    expect(p.checked).toBe(false)
    expect(p.kind === 'note-delete-at' && p.executable).toBe(false)
    expect(p.kind === 'note-delete-at' && p.elapsedDays).toBe(3)
  })

  test('a future delete_at is the normal state of the key, and is refused as such', async () => {
    const deleteAt = new Date(NOW + 10 * DAY).toISOString()
    const { deps } = harness({ getCards: () => [card('a', { deleteAt })] })
    const out = await sweepBoard(deps)
    expect(out.proposals).toEqual([])
    expect(buckets(out.refused, 'a')).toEqual(['delete-at-pending'])
  })

  test('an unreadable delete_at is reported, never guessed at', async () => {
    const { deps } = harness({ getCards: () => [card('a', { deleteAt: 'soon' })] })
    expect(buckets((await sweepBoard(deps)).refused, 'a')).toEqual(['delete-at-unreadable'])
  })

  test('no delete_at is not a candidate at all', async () => {
    const { deps } = harness({ getCards: () => [card('a')] })
    expect((await sweepBoard(deps)).selected).toEqual([])
  })
})

describe('flag-duplicate', () => {
  const twins = () => [
    card('a', { title: 'wire the morning report surface' }),
    card('b', { title: 'wire the morning report surfaces' }),
  ]

  test('a judged duplicate is proposed against BOTH cards, unticked', async () => {
    const judge: DuplicateJudge = async () => [{ a: 'a', b: 'b', duplicate: true, confidence: 0.8, reason: 'same ask' }]
    const { deps } = harness({ getCards: twins, judgeDuplicates: judge })
    const out = await sweepBoard(deps)
    expect(kinds(out.proposals)).toEqual(['flag-duplicate:a', 'flag-duplicate:b'])
    for (const p of out.proposals) expect(p.checked).toBe(false)
    expect(out.proposals[0].kind === 'flag-duplicate' && out.proposals[0].other).toBe('b')
  })

  test('confidence sorts the section and gates nothing -- a 0.01 duplicate still ships', async () => {
    const judge: DuplicateJudge = async () => [{ a: 'a', b: 'b', duplicate: true, confidence: 0.01, reason: 'faint' }]
    const { deps } = harness({ getCards: twins, judgeDuplicates: judge })
    expect((await sweepBoard(deps)).proposals).toHaveLength(2)
  })

  test('a cleared pair is refused as not-duplicate', async () => {
    const judge: DuplicateJudge = async () => [{ a: 'a', b: 'b', duplicate: false, confidence: 0.1, reason: 'no' }]
    const { deps } = harness({ getCards: twins, judgeDuplicates: judge })
    const out = await sweepBoard(deps)
    expect(out.proposals).toEqual([])
    expect(buckets(out.refused, 'a')).toEqual(['not-duplicate'])
  })

  test('a judge that answers nothing for a pair is a refusal, not a duplicate', async () => {
    const judge: DuplicateJudge = async () => []
    const { deps } = harness({ getCards: twins, judgeDuplicates: judge })
    expect(buckets((await sweepBoard(deps)).refused, 'b')).toEqual(['not-duplicate'])
  })

  test('a judgement returned with the pair reversed still lands on the right pair', async () => {
    const judge: DuplicateJudge = async () => [{ a: 'b', b: 'a', duplicate: true, confidence: 0.5, reason: 'same' }]
    const { deps } = harness({ getCards: twins, judgeDuplicates: judge })
    expect((await sweepBoard(deps)).proposals).toHaveLength(2)
  })

  test('NO judge wired says so in its own bucket, and the fact-kinds still ship', async () => {
    const created = new Date(NOW - 400 * DAY).toISOString()
    const cards = [...twins(), card('cold', { status: 'inbox', created })]
    const { deps } = harness({ getCards: () => cards })
    const out = await sweepBoard(deps)
    expect(kinds(out.proposals)).toEqual(['archive-cold:cold'])
    expect(buckets(out.refused, 'a')).toEqual(['no-duplicate-judge'])
  })

  test('a judge that THROWS is never folded into "they are different"', async () => {
    const created = new Date(NOW - 400 * DAY).toISOString()
    const cards = [...twins(), card('cold', { status: 'inbox', created })]
    const judge: DuplicateJudge = async () => {
      throw new Error('openrouter said no')
    }
    const { deps, log } = harness({ getCards: () => cards, judgeDuplicates: judge })
    const out = await sweepBoard(deps)
    expect(kinds(out.proposals)).toEqual(['archive-cold:cold'])
    expect(buckets(out.refused, 'a')).toEqual(['duplicate-judge-failed'])
    expect(log.join('\n')).toContain('openrouter said no')
  })

  test('the model is never called when the prefilter found nothing', async () => {
    let called = false
    const judge: DuplicateJudge = async () => {
      called = true
      return []
    }
    const { deps } = harness({ getCards: () => [card('a'), card('b')], judgeDuplicates: judge })
    await sweepBoard(deps)
    expect(called).toBe(false)
  })

  test('the cap is REPORTED -- cards the shortlist could not fit land in their own bucket', async () => {
    const cards = Array.from({ length: 12 }, (_, i) => card(`c${String(i).padStart(2, '0')}`, { title: 'one title' }))
    const judge: DuplicateJudge = async () => []
    const { deps } = harness({ getCards: () => cards, judgeDuplicates: judge })
    const out = await sweepBoard(deps)
    // 66 pairs, 40 shown: the rest must be visible as a refusal somewhere.
    expect(out.refused.some(r => r.bucket === 'shortlist-capped')).toBe(true)
  })
})

describe('the accounting the scanner contract exists to enforce', () => {
  test('a mixed board drops nothing -- every selected card is acted on or named', async () => {
    const old = new Date(NOW - 400 * DAY).toISOString()
    const cards = [
      card('promote', { status: 'open' }),
      card('cold', { status: 'inbox', created: old }),
      card('young', { status: 'inbox' }),
      card('nodate', { status: 'inbox', created: '' }),
      card('gone', { deleteAt: new Date(NOW - DAY).toISOString() }),
      card('pending', { deleteAt: new Date(NOW + DAY).toISOString() }),
      card('busy', { status: 'inbox', created: old }),
      card('dup1', { title: 'the very same title here' }),
      card('dup2', { title: 'the very same title here' }),
    ]
    const judge: DuplicateJudge = async () => [
      { a: 'dup1', b: 'dup2', duplicate: true, confidence: 0.9, reason: 'identical' },
    ]
    const { deps } = harness({
      getCards: () => cards,
      getPromises: () => [promise('promote')],
      convs: [conv('busy')],
      judgeDuplicates: judge,
    })

    const report = await runScan(boardSweepScanner, deps)
    expect(report.crashed).toBeUndefined()
    expect(report.unaccounted).toEqual([])
    expect(report.selected).toEqual(['busy', 'cold', 'dup1', 'dup2', 'gone', 'nodate', 'pending', 'promote', 'young'])
    expect(report.acted).toEqual(['cold', 'dup1', 'dup2', 'gone', 'promote'])
  })

  test('a card that earned a proposal is never ALSO counted as a refusal', async () => {
    const old = new Date(NOW - 400 * DAY).toISOString()
    // Cold AND carrying an elapsed delete_at: two proposals, one acted entry.
    const cards = [card('a', { status: 'inbox', created: old, deleteAt: '2020-01-01T00:00:00Z' })]
    const { deps } = harness({ getCards: () => cards })
    const out = await sweepBoard(deps)
    expect(out.acted).toEqual(['a'])
    expect(out.refused).toEqual([])
    expect(kinds(out.proposals)).toEqual(['archive-cold:a', 'note-delete-at:a'])
  })

  test('every bucket the scanner can emit is in its declared vocabulary', async () => {
    const cards = [card('a', { status: 'inbox', created: '' }), card('b', { deleteAt: 'soon' })]
    const { deps } = harness({ getCards: () => cards })
    const out = await sweepBoard(deps)
    for (const r of out.refused) expect(boardSweepScanner.buckets).toContain(r.bucket)
  })

  test('an empty board says why it did nothing rather than shrugging', async () => {
    const { deps } = harness()
    const out = await sweepBoard(deps)
    expect(out.idleReason).toBe('no card on the board is a candidate for any proposal kind')
  })

  test('candidates that all refused says how many were looked at', async () => {
    const { deps } = harness({ getCards: () => [card('a', { status: 'inbox' })] })
    expect((await sweepBoard(deps)).idleReason).toBe('1 candidate card(s) considered, none earned a proposal')
  })

  test('a pass that acted has no idleReason at all', async () => {
    const created = new Date(NOW - 400 * DAY).toISOString()
    const { deps } = harness({ getCards: () => [card('a', { status: 'inbox', created })] })
    expect((await sweepBoard(deps)).idleReason).toBeUndefined()
  })
})

describe('the report is deterministic, because a human diffs it against yesterday', () => {
  test('proposals are ordered by kind, then confidence, then card', async () => {
    const old = new Date(NOW - 400 * DAY).toISOString()
    const cards = [
      card('z-dup', { title: 'a shared duplicate title' }),
      card('a-dup', { title: 'a shared duplicate title' }),
      card('z-cold', { status: 'inbox', created: old }),
      card('a-cold', { status: 'inbox', created: old }),
      card('z-promote'),
      card('a-note', { deleteAt: old }),
    ]
    const judge: DuplicateJudge = async () => [
      { a: 'a-dup', b: 'z-dup', duplicate: true, confidence: 0.4, reason: 'maybe' },
    ]
    const { deps } = harness({
      getCards: () => cards,
      getPromises: () => [promise('z-promote')],
      judgeDuplicates: judge,
    })
    expect(kinds((await sweepBoard(deps)).proposals)).toEqual([
      'promote-delivered:z-promote',
      'archive-cold:a-cold',
      'archive-cold:z-cold',
      'flag-duplicate:a-dup',
      'flag-duplicate:z-dup',
      'note-delete-at:a-note',
    ])
  })
})

describe('daysSince', () => {
  test('an empty or unparseable string is null, which is not zero', () => {
    expect(daysSince('', NOW)).toBeNull()
    expect(daysSince(undefined, NOW)).toBeNull()
    expect(daysSince('   ', NOW)).toBeNull()
    expect(daysSince('last tuesday', NOW)).toBeNull()
  })

  test('whole days, floored, and negative for the future', () => {
    expect(daysSince(new Date(NOW - 2 * DAY - 1000).toISOString(), NOW)).toBe(2)
    expect(daysSince(new Date(NOW + 2 * DAY).toISOString(), NOW)).toBe(-2)
  })

  test('a date-only string parses -- cards are written both ways', () => {
    expect(daysSince('2026-08-11', NOW)).toBe(10)
  })
})

describe('the scanner binding', () => {
  test('declares itself against the registered id and the propose half of the contract', () => {
    expect(boardSweepScanner.id).toBe('morning-report')
    expect(boardSweepScanner.does).toBe('propose')
    expect(boardSweepScanner.tag).toBe('[board-sweep]')
  })
})
