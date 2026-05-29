import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const sentMessages: Array<{ type: string; data: Record<string, unknown> }> = []

vi.mock('@/hooks/use-conversations', () => ({
  wsSend: (type: string, data?: Record<string, unknown>): boolean => {
    sentMessages.push({ type, data: data || {} })
    return true
  },
}))

import { RecapConfigDialog } from './recap-config-dialog'
import { openRecapConfigDialog } from './recap-config-trigger'

function openModal(projectUri = 'claude://default/p') {
  render(<RecapConfigDialog />)
  act(() => openRecapConfigDialog({ projectUri }))
}

function checkbox(): HTMLInputElement {
  return screen.getByRole('checkbox') as HTMLInputElement
}

function generate() {
  fireEvent.click(screen.getByRole('button', { name: /Generate/ }))
}

beforeEach(() => {
  sentMessages.length = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RecapConfigDialog', () => {
  test('opens with Last 7 days and retrospect ON by default', () => {
    openModal()
    expect(checkbox().checked).toBe(true)
  })

  test('picking a sub-week preset auto-disables retrospect', () => {
    openModal()
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(checkbox().checked).toBe(false)
  })

  test('a manual retrospect toggle sticks across preset changes', () => {
    openModal()
    fireEvent.click(checkbox()) // turn OFF manually (was on for last_7)
    expect(checkbox().checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' })) // would default ON
    expect(checkbox().checked).toBe(false) // stays where the user left it
  })

  test('Generate fires recap_create with the label + retrospect flag', () => {
    openModal('claude://default/p')
    generate()
    expect(sentMessages).toHaveLength(1)
    const m = sentMessages[0]
    expect(m.type).toBe('recap_create')
    expect(m.data.projectUri).toBe('claude://default/p')
    expect(m.data.period).toEqual({ label: 'last_7' })
    expect(m.data.retrospect).toBe(true)
  })

  test('cross-project scope sends "*"', () => {
    openModal('*')
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    generate()
    expect(sentMessages[0].data.projectUri).toBe('*')
    expect(sentMessages[0].data.retrospect).toBeUndefined() // off for "today"
  })

  test('custom range reveals date inputs and sends a custom period', () => {
    openModal()
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }))
    generate()
    const period = sentMessages[0].data.period as { label: string; start?: number; end?: number }
    expect(period.label).toBe('custom')
    expect(typeof period.start).toBe('number')
    expect(typeof period.end).toBe('number')
  })
})
