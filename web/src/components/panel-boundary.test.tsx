import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelBoundary } from './panel-boundary'

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('kaboom in panel')
  return <div>healthy child</div>
}

describe('PanelBoundary', () => {
  beforeEach(() => {
    // jsdom has no fetch by default; the boundary reports crashes through it.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    // Silence React's error-boundary console noise for the throwing render.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders children verbatim in the happy path', () => {
    render(
      <PanelBoundary name="Test panel">
        <div>healthy child</div>
      </PanelBoundary>,
    )
    expect(screen.getByText('healthy child')).toBeTruthy()
  })

  it('catches a render error and shows a scoped fallback instead of crashing', () => {
    render(
      <PanelBoundary name="Test panel">
        <Boom shouldThrow={true} />
      </PanelBoundary>,
    )
    expect(screen.getByText(/Test panel failed to render/i)).toBeTruthy()
    expect(screen.getByText(/kaboom in panel/)).toBeTruthy()
    expect(screen.getByText(/rest of the app is still working/i)).toBeTruthy()
  })

  it('reports the crash to /api/crash with the boundary name', () => {
    render(
      <PanelBoundary name="Reporting panel">
        <Boom shouldThrow={true} />
      </PanelBoundary>,
    )
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    expect(fetchMock).toHaveBeenCalled()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/crash')
    const payload = JSON.parse((opts as RequestInit).body as string)
    expect(payload.boundary).toBe('Reporting panel')
    expect(payload.scoped).toBe(true)
    expect(payload.error.message).toBe('kaboom in panel')
  })

  it('retry recovers the subtree once the error condition clears', () => {
    // Module-level flag controls whether the child throws; Retry resets the
    // boundary, the re-render no longer throws, and the child comes back.
    let shouldThrow = true
    function Child() {
      if (shouldThrow) throw new Error('transient')
      return <div>recovered child</div>
    }
    const tree = (
      <PanelBoundary name="Recoverable">
        <Child />
      </PanelBoundary>
    )
    const { rerender } = render(tree)
    expect(screen.getByText(/Recoverable failed to render/i)).toBeTruthy()

    shouldThrow = false
    fireEvent.click(screen.getByText(/Retry/i))
    rerender(tree)
    expect(screen.getByText('recovered child')).toBeTruthy()
  })
})
