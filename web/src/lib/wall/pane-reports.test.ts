import type { EpicActivityEntry } from '@shared/protocol'
import { describe, expect, test } from 'vitest'
import type { PulseFleet, PulseRow } from '@/components/pulse/use-pulse-fleet'
import type { AttentionEntry } from '@/components/wall/attention-entries'
import type { UnattendedRow } from '@/components/wall/runs/use-unattended-runs'
import type { WallPinRow } from '@/components/wall/use-wall-pins'
import type { LedgerRow } from './card-ledger'
import type { RiverRow } from './commit-river'
import {
  attentionReport,
  attentionRowValue,
  cardLedgerReport,
  commitRiverReport,
  commitRowValue,
  pinnedReport,
  pulseReport,
  pulseRowValue,
  runsReport,
} from './pane-reports'

const LIVE = { offsetMs: 0, filter: '' }
const NOW = 1_700_000_000_000

// ---------------------------------------------------------------------------
// P1
// ---------------------------------------------------------------------------

function pulseRow(over: Partial<PulseRow> = {}): PulseRow {
  return {
    id: 'c1',
    conversation: {} as PulseRow['conversation'],
    band: 'working',
    title: 'wall-copy-affordance',
    project: 'remote-claude',
    action: 'editing wall-pane.tsx and eleven other files',
    ageMs: 240_000,
    costUsd: 0.42,
    contextPct: 61,
    host: 'studio',
    model: 'opus',
    ...over,
  }
}

function fleet(rows: PulseRow[], over: Partial<PulseFleet> = {}): PulseFleet {
  return {
    groups: [],
    flat: rows,
    totals: { blocked: 0, needs: 0, working: rows.length, done: 0, idle: 0, expired: 0 },
    expired: [],
    hidden: 0,
    managedHidden: 0,
    query: {} as PulseFleet['query'],
    isEmpty: true,
    ...over,
  }
}

describe('P1 -- a pulse row copies what the 407px line had to throw away', () => {
  test('carries cost, context pressure, host and model, none of which are on screen', () => {
    expect(pulseRowValue(pulseRow())).toBe(
      '[working]  remote-claude  wall-copy-affordance  -- editing wall-pane.tsx and eleven other files  (4m, $0.42, ctx 61%, studio, opus)',
    )
  })

  test('a conversation with no cost recorded yet does not paste `$undefined` or an empty field', () => {
    const value = pulseRowValue(pulseRow({ costUsd: undefined, contextPct: undefined, model: undefined }))
    expect(value.endsWith('(4m, studio)')).toBe(true)
  })

  test('the report says WHY rows are missing, and keeps the two reasons apart', () => {
    const text = pulseReport(fleet([pulseRow()], { hidden: 3, managedHidden: 2 }), LIVE)
    expect(text).toContain('+ 3 hidden by the filter')
    expect(text).toContain('+ 2 machine-run hidden -- +over to show')
  })

  test('is stamped with the cursor and the filter it was taken under', () => {
    const text = pulseReport(fleet([pulseRow()]), { offsetMs: 42 * 60_000, filter: '@anvil' })
    expect(text.split('\n')[0]).toBe('PULSE (P1) -- as of T-42m · filter: @anvil')
  })
})

// ---------------------------------------------------------------------------
// A1
// ---------------------------------------------------------------------------

function ask(over: Partial<AttentionEntry> = {}): AttentionEntry {
  return {
    key: 'req-1',
    tier: 'hard',
    band: 'blocked',
    kind: 'permission',
    conversationId: 'c1',
    project: 'remote-claude',
    title: 'wall-copy-affordance',
    question: 'Allow Bash(git push origin HEAD)?',
    since: NOW - 720_000,
    actions: [],
    ...over,
  }
}

describe('A1 -- the ask is the payload', () => {
  test('the question gets its own line, whole', () => {
    expect(attentionRowValue(ask(), 720_000)).toBe(
      'HARD  remote-claude  wall-copy-affordance  waiting 12m\n  Q: Allow Bash(git push origin HEAD)?',
    )
  })

  test('the detail block rides along -- the row clips it, the clipboard must not', () => {
    const value = attentionRowValue(ask({ detail: 'git push origin HEAD --force-with-lease' }), 60_000)
    expect(value).toContain('  git push origin HEAD --force-with-lease')
  })

  test('an empty queue reports its silence rather than a bare header', () => {
    expect(attentionReport([], NOW, LIVE)).toBe('BLOCKED ON YOU (A1) -- as of now\nnobody is waiting on you')
  })

  test('the wait is measured from `since` against the caller clock, not Date.now()', () => {
    expect(attentionReport([ask()], NOW, LIVE)).toContain('waiting 12m')
  })
})

// ---------------------------------------------------------------------------
// P2
// ---------------------------------------------------------------------------

function river(over: Partial<RiverRow> = {}): RiverRow {
  return {
    key: 'a'.repeat(40),
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaa',
    subject: 'fix(wall): the browser tooltip rendered on top of our own hover panel',
    branch: 'main',
    host: 'studio',
    insertions: 12,
    deletions: 3,
    ageMs: 60_000,
    age: '1m',
    bucket: 'LAST HOUR',
    projectName: 'remote-claude',
    conversationName: 'wall-navigation-and-hover',
    hasConversation: true,
    ...over,
  }
}

describe('P2 -- the report carries the FULL sha and the untruncated subject', () => {
  test('the whole forty characters, not the seven on screen', () => {
    const value = commitRowValue(river())
    expect(value.startsWith('a'.repeat(40))).toBe(true)
    expect(value).toContain('fix(wall): the browser tooltip rendered on top of our own hover panel')
  })

  test('a commit made outside a conversation says so instead of naming nothing', () => {
    expect(commitRowValue(river({ hasConversation: false, conversationName: null }))).toContain('terminal')
  })

  test('the report is one line per commit, under the stamped head', () => {
    const text = commitRiverReport([river(), river({ hash: 'b'.repeat(40), key: 'b' })], LIVE)
    expect(text.split('\n')).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// P3
// ---------------------------------------------------------------------------

function move(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    key: 'wall-copy-affordance@1',
    id: 'wall-copy-affordance',
    project: 'claude://default/repo',
    projectName: 'remote-claude',
    title: 'WALL: universal copy',
    priority: 'medium',
    from: 'in-progress',
    to: 'in-review',
    isDone: false,
    ts: NOW,
    ageMs: 60_000,
    age: '1m',
    ...over,
  }
}

describe('P3 -- a card move pastes as the crossing it was', () => {
  test('names the card, both lanes, and the project', () => {
    expect(cardLedgerReport([move()], LIVE).split('\n')[1]).toBe(
      'wall-copy-affordance  in-progress -> in-review  [medium]  WALL: universal copy  (remote-claude, 1m)',
    )
  })

  test('a card with no priority does not paste an empty bracket', () => {
    expect(cardLedgerReport([move({ priority: undefined })], LIVE)).not.toContain('[]')
  })
})

// ---------------------------------------------------------------------------
// A8
// ---------------------------------------------------------------------------

function pin(over: Partial<WallPinRow> = {}): WallPinRow {
  return {
    project: 'claude://default/repo',
    projectName: 'remote-claude',
    epicId: 'epic-the-wall-ii',
    epicTitle: 'THE WALL II',
    done: 14,
    total: 20,
    pct: 70,
    children: [
      { slug: 'wall-copy-affordance', title: 'universal copy', marker: '▸', lane: 'in-progress', mtime: NOW },
      { slug: 'wall-integration-fallow-debt', title: 'fallow debt', marker: '·', lane: 'waiting on deps', mtime: NOW },
    ],
    cap: 5,
    hidden: 0,
    movedAt: NOW,
    ...over,
  }
}

describe('A8 -- the watchlist pastes what is LEFT, past the render cap', () => {
  test('the epic line, then every open child indented under it', () => {
    expect(pinnedReport([pin()], LIVE).split('\n')).toEqual([
      'PINNED (A8) -- as of now',
      'remote-claude :: epic-the-wall-ii  THE WALL II  14/20 (70%)',
      '  ▸  wall-copy-affordance  universal copy  -- in-progress',
      '  ·  wall-integration-fallow-debt  fallow debt  -- waiting on deps',
    ])
  })

  test('carries children the ROW capped away -- the paste is the list, not the fold', () => {
    const many = pin({ cap: 1, hidden: 1 })
    expect(pinnedReport([many], LIVE)).toContain('wall-integration-fallow-debt')
  })
})

// ---------------------------------------------------------------------------
// A7
// ---------------------------------------------------------------------------

function entry(over: Partial<EpicActivityEntry> = {}): EpicActivityEntry {
  return {
    epicId: 'epic-the-wall-ii',
    project: 'claude://default/repo',
    status: 'running',
    gen: 9,
    maxGens: 12,
    inFlight: 3,
    overseerAlive: true,
    armed: true,
    lastBeatAt: new Date(NOW - 30_000).toISOString(),
    stale: false,
    ...over,
  }
}

function epicRun(over: Partial<EpicActivityEntry> = {}): UnattendedRow {
  // The row's id FOLLOWS the entry's. They are the same epic, and a fixture
  // where they disagree makes a report look right while naming the wrong run.
  const e = entry(over)
  return {
    kind: 'epic',
    key: `epic ${e.epicId}`,
    project: 'claude://default/repo',
    projectName: 'remote-claude',
    epicId: e.epicId,
    entry: e,
  }
}

const nightshift: UnattendedRow = {
  kind: 'nightshift',
  key: 'ns-1',
  project: 'claude://default/repo',
  projectName: 'remote-claude',
  runId: 'ns-1',
  liveWorkers: 4,
}

describe('A7 -- says what the PANE knows and refuses to invent the rest', () => {
  test('an epic run pastes the shared vitality verdict and the generation', () => {
    const text = runsReport([epicRun()], 6, LIVE)
    expect(text).toContain('EPIC  remote-claude  epic-the-wall-ii')
    expect(text).toContain('gen 9/12')
  })

  test('never prints DAG buckets or a lease -- the pane never fetched them', () => {
    const text = runsReport([epicRun()], 6, LIVE)
    expect(text).not.toMatch(/in flight|awaiting verdict|overseer:/)
  })

  test('a nightshift run pastes its live worker count', () => {
    expect(runsReport([nightshift], 6, LIVE)).toContain('NIGHTSHIFT  remote-claude  ns-1  4 workers up')
  })

  test('THE CAP IS SAID OUT LOUD -- a silent truncation reads as "that is everything"', () => {
    const rows = [epicRun(), epicRun({ epicId: 'b' }), epicRun({ epicId: 'c' })]
    expect(runsReport(rows, 1, LIVE)).toContain('+ 2 more running, not inspected')
  })

  test('an idle fleet reports the sentence, not an empty body', () => {
    expect(runsReport([], 6, LIVE)).toContain('nothing is running unattended')
  })

  test('a stopped run is reported under NOT RUNNING, with the reason that stopped it', () => {
    const text = runsReport([epicRun(), epicRun({ epicId: 'b', status: 'paused' })], 6, LIVE)
    expect(text).toContain('NOT RUNNING (1)')
    expect(text).toContain('EPIC  remote-claude  b  PAUSED')
    expect(text).toContain('Paused. Nothing dispatches until RESUME re-arms it.')
  })

  test('the live rows come FIRST, whatever order they arrived in', () => {
    const text = runsReport([epicRun({ epicId: 'b', status: 'paused' }), epicRun()], 6, LIVE)
    expect(text.indexOf('epic-the-wall-ii')).toBeLessThan(text.indexOf('NOT RUNNING'))
  })

  test('"+ N more running" counts LIVE rows only -- it used to count the stopped ones as running', () => {
    const rows = [epicRun(), epicRun({ epicId: 'b' }), epicRun({ epicId: 'c', status: 'paused' })]
    const text = runsReport(rows, 1, LIVE)
    expect(text).toContain('+ 1 more running, not inspected')
    expect(text).not.toContain('+ 2 more running')
  })

  test('the not-running tail is capped too, and says so rather than truncating in silence', () => {
    const rows = [epicRun({ epicId: 'a', status: 'paused' }), epicRun({ epicId: 'b', status: 'aborted' })]
    expect(runsReport(rows, 1, LIVE)).toContain('+ 1 more not running')
  })
})
