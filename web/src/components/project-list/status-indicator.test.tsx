import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import { StatusIndicator } from './status-indicator'

const render = (status: Conversation['status'], adHoc?: boolean) =>
  renderToStaticMarkup(<StatusIndicator status={status} adHoc={adHoc} />)

describe('StatusIndicator ad-hoc', () => {
  // Two failed shapes this guards against, both of which read as IDLE while the
  // conversation was working: (1) a static bolt with `animate-pulse` -- reads as
  // decoration; (2) a spinning ring -- a ring is rotationally symmetric, so
  // rotating it is visually stationary. The motion must come from an ASYMMETRIC
  // element (the orbit dot), never from the ring alone.
  it.each(['active', 'booting', 'starting'] as const)('orbits a dot while %s', status => {
    const html = render(status, true)
    expect(html).toContain('animate-spin')
    expect(html).toContain('bg-amber-400') // the orbiting dot, not just a border ring
    expect(html).toContain('⚡')
  })

  it('never relies on a bare rotating ring for motion', () => {
    const html = render('active', true)
    const spinner = html.slice(html.indexOf('animate-spin'))
    expect(spinner).toContain('bg-amber-400')
  })

  it('drops the spinner when idle and never pulses', () => {
    const html = render('idle', true)
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('animate-pulse')
    expect(html).toContain('⚡')
  })

  it('marks a finished ad-hoc task with a check, not a bolt', () => {
    const html = render('ended', true)
    expect(html).toContain('✓')
    expect(html).not.toContain('⚡')
  })
})

describe('StatusIndicator normal', () => {
  it('keeps the green working spinner', () => {
    expect(render('active')).toContain('animate-spin')
  })

  it('keeps the ENDED pill', () => {
    expect(render('ended')).toContain('ended')
  })
})
