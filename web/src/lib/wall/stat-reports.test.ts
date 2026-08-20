import type { WallHostVitals } from '@shared/wall'
import { describe, expect, test } from 'vitest'
import type { PlanLine } from '@/components/wall/plan/plan-model'
import type { WallReading } from '@/components/wall/wall-reading-bus'
import { hostVitalsRows } from './host-vitals'
import { type SheafRow, type SheafView, SOTU_NOT_DISTILLED, type SotuBlock } from './sheaf-rows'
import { burnReport, fleetReport, hostVitalsReport, planUsageReport, sheafReport, sotuReport } from './stat-reports'

const LIVE = { offsetMs: 0, filter: '' }
const NOW = 1_700_000_000_000

// ---------------------------------------------------------------------------
// A2
// ---------------------------------------------------------------------------

const noBars = { bars: [], total: 0 }

describe('A2 -- the burn report keeps the two splits apart and the cap honest', () => {
  // `formatUsd` is the pane's own money format, compaction and all -- the report
  // uses it rather than a second one, so the paste reads `$1.5k` exactly as the
  // tile above it does.
  test('the headline line carries rate, today, month and the cap state', () => {
    const text = burnReport(
      {
        rate: '$11.40/h',
        todayUsd: 84.2,
        monthUsd: 1540,
        cap: { kind: 'none' },
        projects: noBars,
        features: noBars,
        window: '24h',
      },
      LIVE,
    )
    expect(text.split('\n')[1]).toBe('rate $11.40/h  today $84.20  month $1.5k  no cap')
  })

  test('NO CAP is stated, because it is the state the fleet has actually been in', () => {
    const text = burnReport(
      {
        rate: '--',
        todayUsd: null,
        monthUsd: null,
        cap: { kind: 'none' },
        projects: noBars,
        features: noBars,
        window: '24h',
      },
      LIVE,
    )
    expect(text).toContain('no cap')
  })

  test('a feed that never arrived pastes a DASH, never a zero', () => {
    const text = burnReport(
      {
        rate: '--',
        todayUsd: null,
        monthUsd: null,
        cap: { kind: 'none' },
        projects: noBars,
        features: noBars,
        window: '24h',
      },
      LIVE,
    )
    expect(text).toContain('today --')
    expect(text).not.toContain('today $0.00')
  })

  test('an exceeded cap says OVER', () => {
    const text = burnReport(
      {
        rate: '$1/h',
        todayUsd: 1,
        monthUsd: 200,
        cap: { kind: 'set', capUsd: 100, share: 2, over: true },
        projects: noBars,
        features: noBars,
        window: '24h',
      },
      LIVE,
    )
    expect(text).toContain('cap $100 (200%, OVER)')
  })

  test('PROJECTS and OPENROUTER are separate headings with separate totals', () => {
    const text = burnReport(
      {
        rate: '$1/h',
        todayUsd: 1,
        monthUsd: 1,
        cap: { kind: 'none' },
        projects: { bars: [{ key: 'p', label: 'anvil', costUsd: 6, share: 1 }], total: 6 },
        features: { bars: [{ key: 'f', label: 'recap', costUsd: 2, share: 1 }], total: 2 },
        window: '24h',
      },
      LIVE,
    )
    expect(text).toContain('PROJECTS (24h, $6.00)')
    expect(text).toContain('OPENROUTER (24h, $2.00)')
  })
})

// ---------------------------------------------------------------------------
// S1
// ---------------------------------------------------------------------------

function host(over: Partial<WallHostVitals> = {}): WallHostVitals {
  return {
    nodeId: 'node-1',
    alias: 'studio',
    at: NOW,
    cpuPct: 42,
    memPct: 61,
    diskPct: 99,
    load1: 3.2,
    cores: 12,
    conversations: 7,
    cpuHistory: [40, 41, 42],
    ...over,
  }
}

describe('S1 -- the report is the SAME sentence the row copies', () => {
  test('one vitals line per node', () => {
    const rows = hostVitalsRows([host()], NOW)
    expect(hostVitalsReport(rows, LIVE).split('\n')[1]).toBe(
      'studio  cpu 42%  ram 61%  disk 99%  load 3.20/12  convs 7  sampled 0s ago',
    )
  })

  test('a node that stopped reporting carries its staleness INTO the paste', () => {
    const rows = hostVitalsRows([host({ at: NOW - 3_600_000 })], NOW)
    expect(hostVitalsReport(rows, LIVE)).toContain('LAST SEEN 1h ago')
  })
})

// ---------------------------------------------------------------------------
// S2
// ---------------------------------------------------------------------------

function planLine(over: Partial<PlanLine> = {}): PlanLine {
  return {
    key: 'a@studio',
    profile: 'profile-a',
    node: 'studio',
    segments: [],
    latest: { profile: 'profile-a', node: 'studio', utilization: 84, at: NOW, state: 'ok', resetsAt: NOW + 8_040_000 },
    color: '#fff',
    ...over,
  }
}

describe('S2 -- utilization only means something when the sample is OK', () => {
  test('an ok sample pastes the percentage and the reset countdown', () => {
    expect(planUsageReport([planLine()], NOW, LIVE).split('\n')[1]).toBe('profile-a@studio  84%  resets in 2h14m')
  })

  test('a non-ok sample pastes the STATE rather than a meaningless number', () => {
    const line = planLine({ latest: { profile: 'profile-a', utilization: 84, at: NOW, state: 'unknown' } })
    const text = planUsageReport([line], NOW, LIVE)
    expect(text).toContain('unknown')
    expect(text).not.toContain('84%')
  })
})

// ---------------------------------------------------------------------------
// A6
// ---------------------------------------------------------------------------

function sheafRow(over: Partial<SheafRow> = {}): SheafRow {
  return {
    projectUri: 'claude://default/repo',
    projectName: 'remote-claude',
    costUsd: 12.5,
    conversations: 42,
    trees: 7,
    inputTokens: 9_400_000,
    outputTokens: 790_000,
    alerts: [],
    unmergedCommits: 0,
    costShare: 1,
    ...over,
  }
}

const sheaf: SheafView = {
  windowH: 24,
  totals: { costUsd: 12.5, conversations: 42, trees: 7 } as SheafView['totals'],
  rows: [],
  clipped: 0,
}

describe('A6 -- the totals line, then a row per project', () => {
  test('the window and the three totals lead', () => {
    expect(sheafReport(sheaf, [sheafRow()], LIVE).split('\n')[1]).toBe(
      '24h window  $12.50 spent  42 conversations  7 spawn trees',
    )
  })

  test('tokens are compacted the same way the row renders them', () => {
    expect(sheafReport(sheaf, [sheafRow()], LIVE)).toContain('9.4M in/790k out')
  })

  test('alerts and unmerged commits ride the row, absent when there are none', () => {
    expect(sheafReport(sheaf, [sheafRow()], LIVE)).not.toContain('ALERTS')
    const loud = sheafReport(sheaf, [sheafRow({ alerts: ['unpushed'], unmergedCommits: 55 })], LIVE)
    expect(loud).toContain('(55 unmerged, ALERTS: unpushed)')
  })

  test('the summariser CLIP is said out loud', () => {
    expect(sheafReport({ ...sheaf, clipped: 4 }, [sheafRow()], LIVE)).toContain('+ 4 lower-cost projects clipped')
  })
})

// ---------------------------------------------------------------------------
// A4
// ---------------------------------------------------------------------------

function block(over: Partial<SotuBlock> = {}): SotuBlock {
  return {
    projectUri: 'claude://default/repo',
    projectName: 'remote-claude',
    narrative: 'Main is +55 ahead of origin and UNPUSHED. Sixteen worktrees, none integrated.',
    alerts: [],
    contended: 0,
    unmerged: 0,
    ...over,
  }
}

describe('A4 -- the prose is the payload, taken from the block and not the DOM', () => {
  test('the narrative pastes whole, indented under its project', () => {
    expect(sotuReport([], [block()], LIVE).split('\n')[2]).toBe(
      '  Main is +55 ahead of origin and UNPUSHED. Sixteen worktrees, none integrated.',
    )
  })

  // A chronicle-OFF project never reaches this roster -- the broker leaves it off
  // `sotu.blocks` -- so there is exactly ONE silence left to report, and the pane
  // and the paste print the same sentence from the same constant.
  test('a project with nothing distilled says WHY rather than pasting a blank line', () => {
    const text = sotuReport([], [block({ narrative: undefined })], LIVE)
    expect(text).toContain(SOTU_NOT_DISTILLED)
  })

  test('the fleet pills lead when there are any', () => {
    const text = sotuReport([{ key: 'a', label: '3 unpushed', tone: 'warn', title: '' }], [block()], LIVE)
    expect(text.split('\n')[1]).toBe('3 unpushed')
  })
})

// ---------------------------------------------------------------------------
// P4
// ---------------------------------------------------------------------------

describe('P4 -- built from what the tiles PUBLISHED, dashes and all', () => {
  const readings: WallReading[] = [
    { label: 'TOKENS/MIN', value: '12.4k', sub: 'in + out, last 2m' },
    { label: 'TOKENS 24H', value: '9.4M', sub: 'in + out, rolling', stale: true },
    { label: 'WS RTT', value: null },
  ]

  test('one line per mounted tile, in tile order', () => {
    expect(fleetReport(readings, LIVE).split('\n').slice(1)).toEqual([
      'TOKENS/MIN  12.4k  (in + out, last 2m)',
      'TOKENS 24H  9.4M  STALE  (in + out, rolling)',
      'WS RTT  --',
    ])
  })

  test('a tile with no feed pastes the dash it is showing, never a zero', () => {
    expect(fleetReport(readings, LIVE)).not.toContain('WS RTT  0')
  })

  test('no tile mounted at all reports the filter, not an empty body', () => {
    expect(fleetReport([], LIVE)).toContain('no tile matches the filter')
  })
})
