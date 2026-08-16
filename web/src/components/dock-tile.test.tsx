/**
 * The parked tile is the only surface a parked window has.
 *
 * Two properties are worth pinning: a surface that reports nothing looks exactly
 * as it always did (the feature is opt-in, and a silent surface must not start
 * sprouting badges), and a finished run stands its badge DOWN once it has been
 * seen.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SurfaceActivity } from '@/hooks/modal-manager-types'
import { DockTile } from './dock-tile'

afterEach(cleanup)

function tile(activity?: SurfaceActivity) {
  const { container } = render(
    <DockTile title="Vacuum" owner="global" onRestore={vi.fn()} onClose={vi.fn()} {...(activity && { activity })} />,
  )
  return container
}

describe('a parked tile', () => {
  it('is unchanged for a surface that reports nothing', () => {
    const c = tile()
    expect(c.querySelector('.lucide-minus')).toBeTruthy()
    expect(c.querySelector('.lucide-check')).toBeNull()
    expect(c.firstElementChild?.className).not.toMatch(/emerald|amber|red/)
  })

  it('shows the running label the surface reported, verbatim', () => {
    tile({ status: 'running', label: '3/7 months', pulseAt: 1, unseen: false })
    expect(screen.getByText('3/7 months')).toBeTruthy()
  })

  it('draws a determinate bar only when progress is known', () => {
    const withProgress = tile({ status: 'running', progress: 0.42, unseen: false })
    expect(withProgress.querySelector('[style*="42%"]')).toBeTruthy()
    cleanup()
    expect(tile({ status: 'running', unseen: false }).querySelector('[style*="%"]')).toBeNull()
  })

  it('flags a finish nobody has seen yet', () => {
    const c = tile({ status: 'done', label: 'reclaimed 3 GB', finishedAt: 1, unseen: true })
    expect(c.querySelector('.lucide-check')).toBeTruthy()
    expect(c.firstElementChild?.className).toMatch(/emerald/)
  })

  it('stands the badge down once the finish has been seen', () => {
    const c = tile({ status: 'done', label: 'reclaimed 3 GB', finishedAt: 1, unseen: false })
    expect(c.querySelector('.lucide-check')).toBeTruthy()
    expect(c.firstElementChild?.className).not.toMatch(/emerald/)
  })

  it('keeps a failure loud whether or not it has been seen', () => {
    const c = tile({ status: 'error', label: 'gate refused', finishedAt: 1, unseen: false })
    expect(c.querySelector('.lucide-triangle-alert')).toBeTruthy()
    expect(c.firstElementChild?.className).toMatch(/red/)
  })
})
