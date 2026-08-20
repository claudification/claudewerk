/**
 * THE COPY AFFORDANCE, and the one thing both implementations this card replaced
 * got wrong: the failure path.
 *
 * `CopyIconButton` swallowed the rejection into `.catch(() => {})` and
 * `VitalsCopyButton` into `setCopied(false)`. Either way the user pressed a copy
 * button, nothing landed on the clipboard, and nothing on screen said so -- then
 * they pasted whatever was there before. These tests exist so that cannot come
 * back.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWallCursorStore } from '@/lib/wall/cursor-store'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { WallCopyButton } from './wall-copy-button'
import { WallPane } from './wall-pane'

/** Every toast the bus raised during a test. */
const toasts: CustomEvent[] = []

function onToast(e: Event) {
  toasts.push(e as CustomEvent)
}

function withClipboard(writeText: ReturnType<typeof vi.fn> | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  })
}

beforeEach(() => {
  toasts.length = 0
  window.addEventListener('rclaude-toast', onToast)
  useWallFilterStore.getState().clear()
  useWallCursorStore.setState({ offsetMs: 0 })
})

afterEach(() => {
  window.removeEventListener('rclaude-toast', onToast)
  cleanup()
})

describe('WallCopyButton -- the value goes over, and what happened is said', () => {
  it('hands over the VALUE it was given, never the rendered text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    withClipboard(writeText)
    render(<WallCopyButton text={'a'.repeat(40)} label="the sha aaaaaaa" />)

    fireEvent.click(screen.getByLabelText('Copy the sha aaaaaaa'))
    expect(writeText).toHaveBeenCalledWith('a'.repeat(40))
  })

  it('calls a THUNK at click time -- a pane report is not folded on every render', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    withClipboard(writeText)
    const build = vi.fn(() => 'the report')
    render(<WallCopyButton text={build} label="PULSE" />)

    expect(build).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Copy PULSE'))
    expect(build).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('the report')
  })

  it('confirms what landed, by name', async () => {
    withClipboard(vi.fn().mockResolvedValue(undefined))
    render(<WallCopyButton text="x" label="the sha aaaaaaa" />)

    fireEvent.click(screen.getByLabelText('Copy the sha aaaaaaa'))
    await waitFor(() => expect(toasts).toHaveLength(1))
    expect(toasts[0].detail.title).toBe('Copied the sha aaaaaaa')
    expect(toasts[0].detail.variant).toBe('success')
  })

  it('REPORTS a refused clipboard rather than swallowing it', async () => {
    withClipboard(vi.fn().mockRejectedValue(new Error('Write permission denied.')))
    render(<WallCopyButton text="x" label="the sha aaaaaaa" />)

    fireEvent.click(screen.getByLabelText('Copy the sha aaaaaaa'))

    // Both halves of the report: the toast for the main window...
    await waitFor(() => expect(toasts).toHaveLength(1))
    expect(toasts[0].detail.variant).toBe('error')
    expect(toasts[0].detail.body).toContain('Write permission denied.')

    // ...and the BUTTON, which is the half that survives a detached wall, where
    // no ToastContainer is mounted at all.
    const failed = await screen.findByLabelText(/Copy failed/)
    expect(failed.getAttribute('data-copy-state')).toBe('failed')
    expect(failed.getAttribute('title')).toContain('Write permission denied.')
  })

  it('treats an ABSENT clipboard as a refusal, not as nothing happening', async () => {
    withClipboard(undefined)
    render(<WallCopyButton text="x" label="PULSE" />)

    fireEvent.click(screen.getByLabelText('Copy PULSE'))
    await waitFor(() => expect(toasts).toHaveLength(1))
    expect(toasts[0].detail.variant).toBe('error')
    expect(screen.getByLabelText(/Copy failed/)).toBeTruthy()
  })

  it('does not also fire the row click underneath it', () => {
    withClipboard(vi.fn().mockResolvedValue(undefined))
    const open = vi.fn()
    render(
      // biome-ignore lint/a11y/useKeyWithClickEvents: a stand-in for the river row, which wires its own keys
      <div onClick={open}>
        <WallCopyButton text="x" label="the sha" />
      </div>,
    )

    fireEvent.click(screen.getByLabelText('Copy the sha'))
    expect(open).not.toHaveBeenCalled()
  })
})

describe('the pane header -- every pane copies a STAMPED report', () => {
  it('stamps the cursor offset and the active filter onto what it hands over', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    withClipboard(writeText)
    useWallFilterStore.getState().setRaw('@anvil')
    useWallCursorStore.setState({ offsetMs: 42 * 60_000 })

    render(
      <WallPane title="PULSE" code="P1" rewind="rows" report={() => 'PULSE (P1) -- as of T-42m · filter: @anvil\nrow'}>
        <span>body</span>
      </WallPane>,
    )

    fireEvent.click(screen.getByLabelText('Copy PULSE (P1)'))
    expect(writeText).toHaveBeenCalledWith('PULSE (P1) -- as of T-42m · filter: @anvil\nrow')
  })

  it('a BLIND pane has no copy button -- there is nothing on screen to report', () => {
    // No `rewind` declared: at a past offset this pane has no history, so its
    // body is replaced. A copy button there would hand over rows nobody is
    // looking at.
    useWallCursorStore.setState({ offsetMs: 42 * 60_000 })
    render(
      <WallPane title="FLEET" code="P4" report={() => 'should never be reachable'}>
        <span>body</span>
      </WallPane>,
    )

    expect(screen.getByText('no history at this offset')).toBeTruthy()
    expect(screen.queryByLabelText('Copy FLEET (P4)')).toBeNull()
  })
})
