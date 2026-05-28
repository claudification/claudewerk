import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SentinelStatusInfo } from '@/hooks/use-conversations'
import { BatchBroadcastInput, BatchReassignInputs } from './batch-action-inputs'

afterEach(cleanup)

describe('BatchBroadcastInput', () => {
  it('renders the current value', () => {
    render(<BatchBroadcastInput value="hello world" onChange={vi.fn()} />)
    const ta = screen.getByPlaceholderText(/Message to broadcast/) as HTMLTextAreaElement
    expect(ta.value).toBe('hello world')
  })

  it('emits change events', () => {
    const onChange = vi.fn()
    render(<BatchBroadcastInput value="" onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText(/Message to broadcast/), { target: { value: 'hey' } })
    expect(onChange).toHaveBeenCalledWith('hey')
  })
})

describe('BatchReassignInputs', () => {
  const sentinels: SentinelStatusInfo[] = [
    {
      sentinelId: 'sent-abc-def-123',
      alias: 'primary',
    } as SentinelStatusInfo,
  ]

  it('renders three inputs (project, sentinel dropdown, profile) and lists provided sentinels', () => {
    render(
      <BatchReassignInputs
        project=""
        sentinel=""
        profile=""
        sentinels={sentinels}
        onProjectChange={vi.fn()}
        onSentinelChange={vi.fn()}
        onProfileChange={vi.fn()}
      />,
    )
    expect(screen.getByPlaceholderText(/projectUri/i)).toBeDefined()
    expect(screen.getByPlaceholderText(/profile.*unchanged/i)).toBeDefined()
    expect(screen.getByRole('option', { name: /primary/i })).toBeDefined()
  })

  it('emits onSentinelChange with the magic __clear__ token', () => {
    const onSentinelChange = vi.fn()
    render(
      <BatchReassignInputs
        project=""
        sentinel=""
        profile=""
        sentinels={sentinels}
        onProjectChange={vi.fn()}
        onSentinelChange={onSentinelChange}
        onProfileChange={vi.fn()}
      />,
    )
    const select = screen.getByDisplayValue(/leave sentinel unchanged/) as HTMLSelectElement
    fireEvent.change(select, { target: { value: '__clear__' } })
    expect(onSentinelChange).toHaveBeenCalledWith('__clear__')
  })
})
