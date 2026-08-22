import { SCANNER_IDS } from '@shared/scanner-ids'
import type { ScannerToggles } from '@shared/scanner-opt-in'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScannersPanel } from './scanners-panel'

afterEach(cleanup)

describe('ScannersPanel', () => {
  it('offers one checkbox per declared scanner id, so a sixth cannot be invisible', () => {
    render(<ScannersPanel settings={{}} toggles={{}} onToggle={vi.fn()} />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(SCANNER_IDS.length)
  })

  it('renders every box UNCHECKED for a project that was never configured', () => {
    render(<ScannersPanel settings={{}} toggles={{}} onToggle={vi.fn()} />)
    for (const box of screen.getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(false)
    }
  })

  it('checks only the scanner that is switched on', () => {
    render(<ScannersPanel settings={{}} toggles={{ epics: true }} onToggle={vi.fn()} />)
    const epics = screen.getByLabelText('Enable the Epics scanner for this project') as HTMLInputElement
    const refine = screen.getByLabelText('Enable the Refine scanner for this project') as HTMLInputElement
    expect(epics.checked).toBe(true)
    expect(refine.checked).toBe(false)
  })

  it('emits the scanner id and the new state when a box is ticked', () => {
    const onToggle = vi.fn()
    render(<ScannersPanel settings={{}} toggles={{}} onToggle={onToggle} />)
    fireEvent.click(screen.getByLabelText('Enable the Epics scanner for this project'))
    expect(onToggle).toHaveBeenCalledWith('epics', true)
  })

  it('emits false when an already-ticked box is unticked', () => {
    const onToggle = vi.fn()
    render(<ScannersPanel settings={{}} toggles={{ epics: true }} onToggle={onToggle} />)
    fireEvent.click(screen.getByLabelText('Enable the Epics scanner for this project'))
    expect(onToggle).toHaveBeenCalledWith('epics', false)
  })

  it('says "last ran never" for every scanner with no stamp', () => {
    render(<ScannersPanel settings={{}} toggles={{}} onToggle={vi.fn()} />)
    expect(screen.getAllByText('last ran never')).toHaveLength(SCANNER_IDS.length)
  })

  it('shows how long ago a stamped scanner last ran', () => {
    const settings = { scanners: { epics: true }, scannersLastRun: { epics: Date.now() - 120_000 } }
    render(<ScannersPanel settings={settings} toggles={{ epics: true }} onToggle={vi.fn()} />)
    expect(screen.getByText('last ran 2m ago')).toBeDefined()
    // The other four are still the sentence that makes someone look.
    expect(screen.getAllByText('last ran never')).toHaveLength(SCANNER_IDS.length - 1)
  })

  it('flags "enabled, last ran never" in amber -- the shape of an engine that died quietly', () => {
    render(<ScannersPanel settings={{}} toggles={{ epics: true }} onToggle={vi.fn()} />)
    const never = screen.getAllByText('last ran never')
    const amber = never.filter(el => el.className.includes('amber'))
    expect(amber).toHaveLength(1)
  })

  it("ticks a box whose toggle is stored under a renamed id's old spelling", () => {
    // A project that opted in before the singular rename has `work-orders` in
    // its stored map. A raw `toggles[id]` would draw that box UNTICKED while the
    // scanner is in fact running -- the panel lying about an unattended agent.
    const legacy = { 'work-orders': true } as ScannerToggles
    render(<ScannersPanel settings={{}} toggles={legacy} onToggle={vi.fn()} />)
    const box = screen.getByLabelText('Enable the Work order scanner for this project') as HTMLInputElement
    expect(box.checked).toBe(true)
  })

  it('reads the stamps from the SAVED settings, not from the unsaved toggles', () => {
    // The broker owns the stamps and the editor never sends them back, so a box
    // ticked but not yet saved must not invent a run that never happened.
    render(<ScannersPanel settings={{}} toggles={{ refine: true }} onToggle={vi.fn()} />)
    expect(screen.getAllByText('last ran never')).toHaveLength(SCANNER_IDS.length)
  })
})
