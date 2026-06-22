import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LiveStatus } from '@/lib/types'
import { StatusIcon } from './status-icon'

const st = (over: Partial<LiveStatus> = {}): LiveStatus => ({
  state: 'done',
  seq: 1,
  updatedAt: Date.now() - 5 * 60_000,
  ...over,
})

describe('StatusIcon', () => {
  it('renders nothing without a status', () => {
    expect(renderToStaticMarkup(<StatusIcon status={undefined} />)).toBe('')
  })

  it('renders the state glyph + age', () => {
    const html = renderToStaticMarkup(<StatusIcon status={st({ state: 'done' })} />)
    expect(html).toContain('✓')
    expect(html).toContain('5m')
    expect(html).toContain('DONE')
  })

  it('shows the closeable marker only when safe_to_close', () => {
    expect(renderToStaticMarkup(<StatusIcon status={st({ safe_to_close: true })} />)).toContain('✕')
    expect(renderToStaticMarkup(<StatusIcon status={st({ safe_to_close: false })} />)).not.toContain('✕')
  })

  it('dims + strikes a superseded status (user input after updatedAt) and notes it', () => {
    const status = st({ updatedAt: 1000 })
    const html = renderToStaticMarkup(<StatusIcon status={status} lastInputAt={2000} />)
    expect(html).toContain('opacity-40')
    expect(html).toContain('line-through')
    expect(html).toContain('superseded')
  })

  it('does NOT dim when the status is current (input predates it)', () => {
    const status = st({ updatedAt: 5000 })
    const html = renderToStaticMarkup(<StatusIcon status={status} lastInputAt={4000} />)
    expect(html).not.toContain('opacity-40')
    expect(html).not.toContain('superseded')
  })

  it('hides the visible age span when showAge is false (tooltip still carries it)', () => {
    const html = renderToStaticMarkup(<StatusIcon status={st({ updatedAt: Date.now() - 3000 })} showAge={false} />)
    // The age still lives in the hover tooltip, but the standalone age span (its
    // dim class) must not render.
    expect(html).not.toContain('text-[9px]')
    expect(html).toContain('3s ago') // tooltip
  })
})
