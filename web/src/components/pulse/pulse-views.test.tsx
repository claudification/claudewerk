import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PulseBand } from '@/lib/pulse/bands'
import { parsePulseQuery } from '@/lib/pulse/filter'
import { PulseBandsView } from './pulse-bands-view'
import { PulseChips } from './pulse-chips'
import { PulsePaletteHeader } from './pulse-palette-header'
import { PulseRowItem } from './pulse-row'
import { PulseStripBar } from './pulse-strip-bar'
import { PulseTideView } from './pulse-tide-view'
import type { PulseFleet, PulseRow } from './use-pulse-fleet'

afterEach(cleanup)

let seq = 0
function row(over: Partial<PulseRow> = {}): PulseRow {
  seq += 1
  return {
    id: `conv_${seq}`,
    conversation: { id: `conv_${seq}` } as PulseRow['conversation'],
    band: 'needs',
    title: 'epic-run ceiling copy',
    project: 'remote-claude',
    action: 'permission: rm -rf',
    tag: 'worktree-epic-run',
    ageMs: 60_000,
    ...over,
  }
}

const ZERO_TOTALS: Record<PulseBand, number> = { needs: 0, working: 0, done: 0, idle: 0, expired: 0 }

function fleet(over: Partial<PulseFleet> = {}): PulseFleet {
  const groups = over.groups ?? []
  return {
    groups,
    flat: over.flat ?? groups.flatMap(g => g.rows),
    totals: { ...ZERO_TOTALS, ...over.totals },
    expired: over.expired ?? [],
    hidden: over.hidden ?? 0,
    managedHidden: over.managedHidden ?? 0,
    query: over.query ?? parsePulseQuery(''),
    isEmpty: over.isEmpty ?? true,
  }
}

describe('PulseRowItem', () => {
  it('shows title, project, action and a humanised age', () => {
    render(<PulseRowItem row={row({ ageMs: 120_000 })} query={parsePulseQuery('')} onSelect={vi.fn()} />)
    expect(screen.getByText('epic-run ceiling copy')).toBeTruthy()
    expect(screen.getByText('remote-claude')).toBeTruthy()
    expect(screen.getByText('permission: rm -rf')).toBeTruthy()
    expect(screen.getByText('2m')).toBeTruthy()
  })

  it('tints the project and draws its icon when the project has settings', () => {
    // The project used to render as flat grey mono on every row, so a
    // hundred-row fleet gave no way to tell one project from another at a
    // glance -- the icon + colour already existed in project settings and the
    // command palette drew them; Pulse simply threw them away.
    const { container } = render(
      <PulseRowItem
        row={row({ projectIcon: 'rocket', projectColor: 'oklch(0.7 0.15 250)' })}
        query={parsePulseQuery('')}
        onSelect={vi.fn()}
      />,
    )
    const tag = screen.getByText('remote-claude').closest('span[style]')
    expect(tag?.getAttribute('style')).toContain('oklch(0.7 0.15 250)')
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('leaves the project uncoloured when the project has no settings', () => {
    const { container } = render(<PulseRowItem row={row()} query={parsePulseQuery('')} onSelect={vi.fn()} />)
    expect(screen.getByText('remote-claude')).toBeTruthy()
    expect(container.querySelector('svg')).toBeNull()
  })

  it('floors a very fresh row to "now" instead of flickering seconds', () => {
    render(<PulseRowItem row={row({ ageMs: 500 })} query={parsePulseQuery('')} onSelect={vi.fn()} />)
    expect(screen.getByText('now')).toBeTruthy()
  })

  it('highlights the free-text hit inside the title', () => {
    const { container } = render(<PulseRowItem row={row()} query={parsePulseQuery('ceiling')} onSelect={vi.fn()} />)
    const mark = container.querySelector('mark')
    expect(mark?.textContent).toBe('ceiling')
  })

  it('does not highlight when the hit was in another field', () => {
    const { container } = render(<PulseRowItem row={row()} query={parsePulseQuery('permission')} onSelect={vi.fn()} />)
    expect(container.querySelector('mark')).toBeNull()
  })

  it('fires onSelect and onHover', () => {
    const onSelect = vi.fn()
    const onHover = vi.fn()
    render(<PulseRowItem row={row()} query={parsePulseQuery('')} onSelect={onSelect} onHover={onHover} />)
    const btn = screen.getByRole('button')
    fireEvent.mouseEnter(btn)
    fireEvent.click(btn)
    expect(onHover).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('renders the card treatment without losing any field', () => {
    render(<PulseRowItem row={row()} query={parsePulseQuery('')} onSelect={vi.fn()} />)
    expect(screen.getByText('epic-run ceiling copy')).toBeTruthy()
    expect(screen.getByText('permission: rm -rf')).toBeTruthy()
  })
})

describe('PulseBandsView', () => {
  const needs = [row({ band: 'needs' }), row({ band: 'needs' })]
  const idle = Array.from({ length: 6 }, () => row({ band: 'idle', title: 'parked thing' }))

  it('renders a band header with the full band count', () => {
    const f = fleet({ groups: [{ band: 'needs', rows: needs }], totals: { ...ZERO_TOTALS, needs: 2 } })
    render(<PulseBandsView fleet={f} activeId={null} onSelect={vi.fn()} />)
    expect(screen.getByText('NEEDS YOU')).toBeTruthy()
  })

  it('folds a long band behind a "more" affordance, and unfolds on click', () => {
    const f = fleet({ groups: [{ band: 'idle', rows: idle }] })
    render(<PulseBandsView fleet={f} activeId={null} onSelect={vi.fn()} />)
    expect(screen.getAllByText('parked thing')).toHaveLength(3)
    fireEvent.click(screen.getByText(/more/))
    expect(screen.getAllByText('parked thing')).toHaveLength(6)
  })

  it('NEVER folds NEEDS YOU — the whole point is that band being complete', () => {
    const many = Array.from({ length: 9 }, () => row({ band: 'needs', title: 'urgent thing' }))
    const f = fleet({ groups: [{ band: 'needs', rows: many }] })
    render(<PulseBandsView fleet={f} activeId={null} onSelect={vi.fn()} />)
    expect(screen.getAllByText('urgent thing')).toHaveLength(9)
    expect(screen.queryByText(/more/)).toBeNull()
  })

  it('keeps expired collapsed to a count until asked', () => {
    const f = fleet({ expired: [row({ band: 'expired', title: 'reaped' })] })
    render(<PulseBandsView fleet={f} activeId={null} onSelect={vi.fn()} />)
    expect(screen.queryByText('reaped')).toBeNull()
    fireEvent.click(screen.getByText('EXPIRED'))
    expect(screen.getByText('reaped')).toBeTruthy()
  })

  it('reports how many rows the filter removed', () => {
    const f = fleet({ groups: [{ band: 'needs', rows: needs }], hidden: 4 })
    render(<PulseBandsView fleet={f} activeId={null} onSelect={vi.fn()} />)
    expect(screen.getByText('4 hidden by filter')).toBeTruthy()
  })

  it('says so when nothing matches', () => {
    render(<PulseBandsView fleet={fleet()} activeId={null} onSelect={vi.fn()} />)
    expect(screen.getByText(/nothing matches/)).toBeTruthy()
  })

  it('ANNOUNCES machine-run rows it hid, and names the token that reveals them', () => {
    // A managed run that is invisible with no explanation is the failure mode.
    const f = fleet({ groups: [{ band: 'needs', rows: needs }], managedHidden: 3 })
    render(<PulseBandsView fleet={f} activeId={null} onSelect={vi.fn()} />)
    expect(screen.getByText(/3 machine-run hidden/)).toBeTruthy()
    expect(screen.getByText('+over')).toBeTruthy()
  })

  it('does not mention machine-run rows when there are none', () => {
    const f = fleet({ groups: [{ band: 'needs', rows: needs }] })
    render(<PulseBandsView fleet={f} activeId={null} onSelect={vi.fn()} />)
    expect(screen.queryByText(/machine-run hidden/)).toBeNull()
  })

  it('reveals on click', () => {
    const onReveal = vi.fn()
    const f = fleet({ groups: [{ band: 'needs', rows: needs }], managedHidden: 2 })
    render(<PulseBandsView fleet={f} activeId={null} onSelect={vi.fn()} onRevealManaged={onReveal} />)
    fireEvent.click(screen.getByText(/machine-run hidden/))
    expect(onReveal).toHaveBeenCalledOnce()
  })

  it('keeps the two hidden counts distinct', () => {
    // "hidden by filter" is something the user typed; "machine-run hidden" is a
    // default they never chose. Conflating them reads as a too-tight filter.
    const f = fleet({ groups: [{ band: 'needs', rows: needs }], hidden: 4, managedHidden: 3 })
    render(<PulseBandsView fleet={f} activeId={null} onSelect={vi.fn()} />)
    expect(screen.getByText('4 hidden by filter')).toBeTruthy()
    expect(screen.getByText(/3 machine-run hidden/)).toBeTruthy()
  })
})

describe('PulseRowItem — machine-run marking', () => {
  it('marks a managed row with its chip', () => {
    const r = row({ managedBy: { kind: 'epic', label: 'OVER', runId: 'ep_1', role: 'implementer' }, managed: true })
    render(<PulseRowItem row={r} query={parsePulseQuery('')} onSelect={vi.fn()} />)
    expect(screen.getByText('OVER')).toBeTruthy()
  })

  it('names the run on hover so the chip is traceable', () => {
    const r = row({ managedBy: { kind: 'epic', label: 'OVER', runId: 'ep_1', role: 'verifier' }, managed: true })
    render(<PulseRowItem row={r} query={parsePulseQuery('')} onSelect={vi.fn()} />)
    expect(screen.getByText('OVER').getAttribute('title')).toBe('epic ep_1 — verifier')
  })

  it('leaves a human-started row unmarked', () => {
    render(<PulseRowItem row={row()} query={parsePulseQuery('')} onSelect={vi.fn()} />)
    expect(screen.queryByText('OVER')).toBeNull()
  })

  it('marks the card treatment too', () => {
    const r = row({ managedBy: { kind: 'nightshift', label: 'NIGHT', runId: 'run_1' }, managed: true })
    render(<PulseRowItem row={r} query={parsePulseQuery('')} onSelect={vi.fn()} />)
    expect(screen.getByText('NIGHT')).toBeTruthy()
  })
})

describe('PulseTideView', () => {
  it('orders strictly by recency, ignoring bands', () => {
    const old = row({ band: 'needs', title: 'old needs', ageMs: 600_000 })
    const fresh = row({ band: 'idle', title: 'fresh idle', ageMs: 1_000 })
    const f = fleet({
      groups: [
        { band: 'needs', rows: [old] },
        { band: 'idle', rows: [fresh] },
      ],
    })
    render(<PulseTideView fleet={f} activeId={null} onSelect={vi.fn()} />)
    const titles = screen.getAllByRole('button').map(b => b.textContent)
    expect(titles[0]).toContain('fresh idle')
    expect(titles[1]).toContain('old needs')
  })

  it('drops an hour divider once the stream crosses it', () => {
    const f = fleet({
      groups: [
        { band: 'working', rows: [row({ band: 'working', ageMs: 1_000 })] },
        { band: 'idle', rows: [row({ band: 'idle', ageMs: 7_200_000 })] },
      ],
    })
    render(<PulseTideView fleet={f} activeId={null} onSelect={vi.fn()} />)
    expect(screen.getByText('1 hour')).toBeTruthy()
  })

  it('says so when nothing matches', () => {
    render(<PulseTideView fleet={fleet()} activeId={null} onSelect={vi.fn()} />)
    expect(screen.getByText(/nothing matches/)).toBeTruthy()
  })
})

describe('PulseChips', () => {
  const totals: Record<PulseBand, number> = { needs: 2, working: 5, done: 3, idle: 4, expired: 7 }

  it('sums only the visible bands into All — expired is not part of the fleet', () => {
    render(<PulseChips totals={totals} active={null} onPick={vi.fn()} />)
    expect(screen.getByText('14')).toBeTruthy()
  })

  it('reports the active band via aria-pressed', () => {
    render(<PulseChips totals={totals} active={['needs']} onPick={vi.fn()} />)
    const chip = screen.getByRole('button', { name: /needs you/i })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
  })

  it('picks a band and clears back to all', () => {
    const onPick = vi.fn()
    render(<PulseChips totals={totals} active={['needs']} onPick={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: /working/i }))
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    expect(onPick).toHaveBeenNthCalledWith(1, 'working')
    expect(onPick).toHaveBeenNthCalledWith(2, null)
  })

  it('CENTRES every chip label, All included', () => {
    // All laid its label out as an inline line box while the band chips used
    // flex. The terminal font's oversized ascent then shoved the baseline past
    // the 16px line box of text-[11px], so "All 80" rendered BELOW its own pill
    // and got clipped by the row edge. Flex centring aligns on the glyph box,
    // which is why the band chips were never affected.
    const { container } = render(<PulseChips totals={totals} active={null} onPick={vi.fn()} />)
    const chips = [...container.querySelectorAll('button')]
    expect(chips.length).toBeGreaterThan(1)
    for (const chip of chips) expectFlexCentred(chip)
  })
})

/** The pill only contains its own label when the label is a flex item — see the
 *  "All 80" / "≡ tide" clipping bug. */
function expectFlexCentred(chip: HTMLElement) {
  const why = `chip "${chip.textContent?.trim()}" is not flex-centred`
  expect(chip.className, why).toMatch(/(^|\s)(inline-)?flex(\s|$)/)
  expect(chip.className, why).toContain('items-center')
}

describe('PulsePaletteHeader', () => {
  function renderHeader(view: 'bands' | 'tide' = 'bands') {
    return render(
      <PulsePaletteHeader
        filter=""
        onFilterChange={vi.fn()}
        inputRef={{ current: null }}
        liveCount={80}
        totals={{ needs: 2, working: 5, done: 3, idle: 4, expired: 7 }}
        activeBands={null}
        onPickBand={vi.fn()}
        view={view}
        onToggleView={vi.fn()}
        board={false}
        onToggleBoard={vi.fn()}
      />,
    )
  }

  it('CENTRES the tide and board toggles like every other chip', () => {
    const { container } = renderHeader('bands')
    for (const label of ['≡ tide', '▦ board']) {
      const chip = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
      expect(chip, `no ${label} toggle`).toBeTruthy()
      expectFlexCentred(chip as HTMLElement)
    }
  })

  it('keeps the board toggle off narrow viewports without an ambiguous display class', () => {
    // The chip shape sets `inline-flex`, so a bare `hidden` on the board toggle
    // would be a coin flip decided by stylesheet order.
    const { container } = renderHeader('bands')
    const board = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === '▦ board')
    expect(board?.className).toContain('max-xl:hidden')
    expect(board?.className).not.toMatch(/(^|\s)hidden(\s|$)/)
  })

  it('keeps the toggles centred in the other view too', () => {
    const { container } = renderHeader('tide')
    const chip = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === '▤ bands')
    expect(chip).toBeTruthy()
    expectFlexCentred(chip as HTMLElement)
  })
})

describe('PulseStripBar', () => {
  const totals: Record<PulseBand, number> = { needs: 2, working: 5, done: 3, idle: 4, expired: 7 }

  it('shows every band count including expired', () => {
    render(<PulseStripBar totals={totals} lead={row()} open={false} onToggle={vi.fn()} />)
    for (const n of ['2', '5', '3', '4', '7']) expect(screen.getByText(n)).toBeTruthy()
  })

  it('shows the lead row inline', () => {
    render(<PulseStripBar totals={totals} lead={row()} open={false} onToggle={vi.fn()} />)
    expect(screen.getByText('epic-run ceiling copy')).toBeTruthy()
    expect(screen.getByText('permission: rm -rf')).toBeTruthy()
  })

  it('says "all quiet" with no lead', () => {
    render(<PulseStripBar totals={ZERO_TOTALS} lead={null} open={false} onToggle={vi.fn()} />)
    expect(screen.getByText('all quiet')).toBeTruthy()
  })

  it('reports its expanded state and toggles', () => {
    const onToggle = vi.fn()
    render(<PulseStripBar totals={totals} lead={row()} open onToggle={onToggle} />)
    const bar = screen.getByRole('button', { name: 'Pulse strip' })
    expect(bar.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(bar)
    expect(onToggle).toHaveBeenCalledOnce()
  })
})
