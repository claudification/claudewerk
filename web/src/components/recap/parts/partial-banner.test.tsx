import type { RecapChunkFailure } from '@shared/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PartialBanner } from './partial-banner'

const sent: Array<{ recapId: string; mode: string }> = []

vi.mock('@/components/recap-jobs/recap-wire', () => ({
  resolveRecap: (recapId: string, mode: string) => {
    sent.push({ recapId, mode })
    return true
  },
}))

const FAILURES: RecapChunkFailure[] = [
  {
    chunkIndex: 148,
    outcome: 'failed',
    conversations: [{ id: '488cbece-b42', title: 'AWS SES production access' }],
    error: 'map JSON parse failed',
    at: 1,
  },
  {
    chunkIndex: 12,
    outcome: 'salvaged',
    conversations: [{ id: 'deadbeef-aaa', title: 'Nightshift ACT bar' }],
    error: 'map JSON parse failed',
    dropped: 3,
    at: 1,
  },
]

afterEach(() => {
  cleanup()
  sent.length = 0
})

describe('PartialBanner', () => {
  test('names every casualty instead of counting them', () => {
    render(<PartialBanner recapId="recap_x" reason="1 conversation(s) dropped of 169" failures={FAILURES} />)
    expect(screen.getByText(/AWS SES production access/)).toBeTruthy()
    expect(screen.getByText(/Nightshift ACT bar/)).toBeTruthy()
    expect(screen.getByText(/1 conversation\(s\) dropped of 169/)).toBeTruthy()
  })

  test('distinguishes a salvaged casualty from a lost one', () => {
    render(<PartialBanner recapId="recap_x" failures={FAILURES} />)
    expect(screen.getByText(/3 fact\(s\) lost/)).toBeTruthy()
    expect(screen.getByText('lost')).toBeTruthy()
    expect(screen.getByText('partial')).toBeTruthy()
  })

  test('offers all three choices, each labelled with its cost', () => {
    render(<PartialBanner recapId="recap_x" failures={FAILURES} />)
    expect(screen.getByText(/Re-run what failed/)).toBeTruthy()
    expect(screen.getByText(/Drop them, rebuild/)).toBeTruthy()
    expect(screen.getByText(/Accept as-is/)).toBeTruthy()
    expect(screen.getByText(/\(free\)/)).toBeTruthy()
  })

  test('sends the chosen resolution over the wire', () => {
    render(<PartialBanner recapId="recap_x" failures={FAILURES} />)
    fireEvent.click(screen.getByText(/Accept as-is/))
    expect(sent).toEqual([{ recapId: 'recap_x', mode: 'accept' }])
  })

  test('each button sends its own mode', () => {
    render(<PartialBanner recapId="recap_y" failures={FAILURES} />)
    fireEvent.click(screen.getByText(/Drop them, rebuild/))
    expect(sent[0]?.mode).toBe('synthesize_only')
  })

  test('an already-resolved recap shows the decision and stops asking', () => {
    render(
      <PartialBanner
        recapId="recap_x"
        failures={FAILURES}
        resolution={{ mode: 'accept', at: 1715000000000, by: 'jonas' }}
      />,
    )
    expect(screen.getByText(/accepted as-is/)).toBeTruthy()
    expect(screen.getByText(/by jonas/)).toBeTruthy()
    expect(screen.queryByText(/Re-run what failed/)).toBeNull()
  })

  test('at the resume cap the re-run paths are blocked but Accept still works', () => {
    // Otherwise a capped recap could never be settled at all -- it would nag
    // forever with every button disabled.
    render(<PartialBanner recapId="recap_x" failures={FAILURES} resumeCount={2} maxResumes={2} />)
    const rerun = screen.getByText(/Re-run what failed/).closest('button')
    const accept = screen.getByText(/Accept as-is/).closest('button')
    expect(rerun?.disabled).toBe(true)
    expect(accept?.disabled).toBe(false)
    fireEvent.click(screen.getByText(/Accept as-is/))
    expect(sent[0]?.mode).toBe('accept')
  })

  test('shows how many resumes are left', () => {
    render(<PartialBanner recapId="recap_x" failures={FAILURES} resumeCount={1} />)
    expect(screen.getByText('1/2 resumes used')).toBeTruthy()
  })
})
