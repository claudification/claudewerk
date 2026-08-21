/**
 * The RUN dialog describes the epic it is about to hand over.
 *
 * It used to render three settings and the epic's slug: you armed an unattended
 * fleet without being told whether that meant two cards or forty, or how many
 * of them could even start. These lock the facts that replaced that silence --
 * and the colour vars, which never resolved because the dialog portals to
 * document.body, outside the pane that defines them.
 */

import type { EpicChild, EpicRollup } from '@shared/epic-cards'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import type { EpicRunState } from '@/lib/epic-run-api'
import { EpicRunDialog } from './epic-run-dialog'

/** A live run, for the RESUME cases. */
const RUN_STATE: EpicRunState = {
  epicId: 'werk-epic',
  status: 'paused',
  gen: 0,
  maxGens: 40,
  cadence: ['now'],
  target: 'merged',
  concurrency: 3,
  plan: true,
  planned: false,
  dryGens: 0,
  digest: '',
}

vi.mock('@/lib/epic-run-api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/epic-run-api')>()),
  startEpicRun: vi.fn(),
}))

function child(slug: string, bucket: EpicChild['bucket'], waitingOn: string[] = []): EpicChild {
  return { card: { slug, title: slug, tags: [] } as unknown as ProjectTaskMeta, bucket, waitingOn }
}

/** Four ready, two dependency-locked, one done, one archived. */
const ROLLUP: EpicRollup = {
  epicId: 'werk-epic',
  card: { slug: 'werk-epic', title: 'Rewire the werk', tags: ['epic'] } as unknown as ProjectTaskMeta,
  children: [
    child('a', 'notStarted'),
    child('b', 'notStarted'),
    child('c', 'notStarted'),
    child('d', 'inProgress'),
    child('e', 'notStarted', ['a']),
    child('f', 'notStarted', ['b']),
    child('g', 'done'),
    child('h', 'dropped'),
  ],
  notStarted: 5,
  inProgress: 1,
  done: 1,
  dropped: 1,
  total: 7,
  pct: 14,
  complete: false,
}

function open(rollup: EpicRollup = ROLLUP) {
  render(
    <EpicRunDialog
      rollup={rollup}
      project="claude://host/proj"
      existing={null}
      onClose={() => {}}
      onStarted={() => {}}
    />,
  )
}

afterEach(cleanup)

it('leads with the epic by NAME, keeping the slug as the subtitle', () => {
  open()
  expect(screen.getByText('Rewire the werk')).toBeTruthy()
  expect(screen.getByText('werk-epic')).toBeTruthy()
})

it('says how much work it is taking on, split by what can actually start', () => {
  open()
  expect(screen.getByText('READY').previousSibling?.textContent).toBe('4')
  expect(screen.getByText('WAITING ON DEPS').previousSibling?.textContent).toBe('2')
  expect(screen.getByText('DONE').previousSibling?.textContent).toBe('1')
  expect(screen.getByText('DROPPED').previousSibling?.textContent).toBe('1')
})

it('turns concurrency into what beat 1 actually dispatches', () => {
  open()
  // Default 3, against 4 ready.
  expect(screen.getByText(/Beat 1 dispatches 3 of 4 ready/)).toBeTruthy()

  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '8' } })
  // Past the ready count the extra slots buy nothing, and it says so.
  expect(screen.getByText(/Beat 1 dispatches all 4 ready cards at once\. 4 slot\(s\) go unused\./)).toBeTruthy()
})

it('resolves the choices into one sentence of consequence', () => {
  open()
  // Planning is on by default, and it happens BEFORE the cadence clause applies.
  expect(
    screen.getByText(
      'Plans the epic first, then: starts now, up to 3 at a time, and stops once each card is merged to main.',
    ),
  ).toBeTruthy()

  fireEvent.click(screen.getByLabelText(/Analyze and create execution plan/i))
  expect(screen.getByText('Starts now, up to 3 at a time, and stops once each card is merged to main.')).toBeTruthy()

  fireEvent.click(screen.getByText('shipped'))
  expect(screen.getByText('Starts now, up to 3 at a time, and does not stop until it is deployed.')).toBeTruthy()
  // The one irreversible choice is the one that was whispering.
  expect(screen.getByText(/Deployed by the fleet, unreviewed/)).toBeTruthy()
})

describe('the planning generation', () => {
  it('is offered, and ticked, on a fresh run', () => {
    open()
    expect((screen.getByLabelText(/Analyze and create execution plan/i) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText(/writes the depends_on edges nobody declared/)).toBeTruthy()
  })

  it('says what turning it OFF costs, rather than going quiet', () => {
    open()
    fireEvent.click(screen.getByLabelText(/Analyze and create execution plan/i))
    expect(screen.getByText(/Only the edges already declared will be honoured/)).toBeTruthy()
  })

  /**
   * A RESUME cannot plan -- generation 0 already ran. Showing a ticked box that
   * the store then ignores is worse than showing no box.
   */
  it('is not offered at all on a run that has already planned', () => {
    render(
      <EpicRunDialog
        rollup={ROLLUP}
        project="claude://host/proj"
        existing={{ ...RUN_STATE, gen: 3, planned: true }}
        onClose={() => {}}
        onStarted={() => {}}
      />,
    )
    expect(screen.queryByLabelText(/Analyze and create execution plan/i)).toBeNull()
  })
})

/**
 * THE `when` AXIS THIS DIALOG CANNOT EXPRESS.
 *
 * Three exclusive buttons over a field that holds a LIST and can hold an
 * APPOINTMENT. Both cases must light NO button and say what the run actually
 * carries -- an appointment that lit nothing AND explained nothing would open
 * this dialog on a run armed for 02:00 looking exactly like a fresh
 * unconfigured one.
 */
describe('a `when` axis the three buttons cannot show', () => {
  const resume = (cadence: EpicRunState['cadence']) =>
    render(
      <EpicRunDialog
        rollup={ROLLUP}
        project="claude://host/proj"
        existing={{ ...RUN_STATE, gen: 3, planned: true, cadence }}
        onClose={() => {}}
        onStarted={() => {}}
      />,
    )

  it('says what a COMPOSED axis carries instead of lighting one of its halves', () => {
    resume(['window', 'queue'])
    expect(screen.getByText(/This run carries window \+ queue/)).toBeTruthy()
  })

  it('says what an APPOINTMENT carries, offset and all', () => {
    resume(['at:2026-08-22T02:00:00+07:00'])
    expect(screen.getByText(/This run carries not before 2026-08-22T02:00:00\+07:00/)).toBeTruthy()
  })

  it('stays quiet when a button genuinely does say it', () => {
    resume(['queue'])
    expect(screen.queryByText(/This run carries/)).toBeNull()
  })
})

it('carries its own epic colour, because it portals outside the pane that sets them', () => {
  open()
  const content = document.querySelector('[data-slot="dialog-content"]') as HTMLElement
  expect(content.style.getPropertyValue('--epic-solid')).toMatch(/^oklch\(/)
  expect(content.style.getPropertyValue('--epic-edge')).toMatch(/^oklch\(/)
})

it('does not claim readiness for a fully dependency-locked epic', () => {
  open({ ...ROLLUP, children: [child('a', 'notStarted', ['x'])], notStarted: 1, inProgress: 0, done: 0, dropped: 0 })
  expect(screen.getByText(/Nothing is ready -- every live card is waiting on a dependency\./)).toBeTruthy()
})
