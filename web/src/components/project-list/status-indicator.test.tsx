import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import { StatusIndicator } from './status-indicator'

const render = (status: Conversation['status'], adHoc?: boolean) =>
  renderToStaticMarkup(<StatusIndicator status={status} adHoc={adHoc} />)

describe('StatusIndicator ad-hoc', () => {
  // The bug this guards: a busy ad-hoc conversation rendered a STATIC bolt with
  // `animate-pulse`, which reads as decoration, so live work looked idle. Busy
  // ad-hoc must carry the same spinning-ring motion as a normal working row.
  it.each(['active', 'booting', 'starting'] as const)('spins while %s', status => {
    const html = render(status, true)
    expect(html).toContain('animate-spin')
    expect(html).toContain('⚡')
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
