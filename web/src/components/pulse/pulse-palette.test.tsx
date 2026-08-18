import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { _resetConversationsMemoForTests } from '@/lib/slim-conversation'
import * as utils from '@/lib/utils'
import { PulsePalette } from './pulse-palette'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  _resetConversationsMemoForTests()
  useConversationsStore.setState({ conversationsById: {} })
})

const desktop = () => vi.spyOn(utils, 'isMobileViewport').mockReturnValue(false)
const mobile = () => vi.spyOn(utils, 'isMobileViewport').mockReturnValue(true)

const sheet = () => screen.getByRole('dialog', { name: /Pulse/ })

describe('PulsePalette — the mobile sheet', () => {
  it('does NOT autofocus the filter on a phone', () => {
    // Focusing raises the software keyboard, which eats half the sheet and
    // turns a glance into a text-entry chore.
    mobile()
    render(<PulsePalette onOpen={vi.fn()} onClose={vi.fn()} />)
    expect(document.activeElement).not.toBe(screen.getByLabelText('Pulse filter'))
  })

  it('DOES autofocus on desktop, where you summoned it to type', () => {
    desktop()
    render(<PulsePalette onOpen={vi.fn()} onClose={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByLabelText('Pulse filter'))
  })

  it('is a HALF sheet on a phone, not the whole screen', () => {
    mobile()
    render(<PulsePalette onOpen={vi.fn()} onClose={vi.fn()} />)
    const cls = sheet().className
    expect(cls).toContain('h-[62dvh]')
    expect(cls).not.toContain('h-dvh ')
  })

  it('rises from the bottom however it was summoned', () => {
    // Swipe from the right, tap the strip, or the chord -- one arrival
    // animation means one mental model for where this thing lives.
    mobile()
    render(<PulsePalette onOpen={vi.fn()} onClose={vi.fn()} />)
    expect(sheet().className).toContain('slide-in-from-bottom')
  })

  it('keeps the input at the bottom edge, under the thumb', () => {
    mobile()
    render(<PulsePalette onOpen={vi.fn()} onClose={vi.fn()} />)
    expect(sheet().className).toContain('flex-col-reverse')
  })

  it('keeps the filter font at 16px+ so iOS does not zoom on focus', () => {
    mobile()
    render(<PulsePalette onOpen={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Pulse filter').className).toContain('text-[19px]')
  })
})
