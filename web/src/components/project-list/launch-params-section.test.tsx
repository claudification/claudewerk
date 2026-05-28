import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import { LaunchParamsSection } from './launch-params-section'

afterEach(cleanup)

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    cwd: '/cwd',
    status: 'idle',
    startedAt: 0,
    lastActivity: 0,
    eventCount: 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
    runningBgTaskCount: 0,
    bgTasks: [],
    teammates: [],
    ...overrides,
  } as Conversation
}

describe('LaunchParamsSection', () => {
  it('renders nothing when no launch params or env entries present', () => {
    const { container } = render(<LaunchParamsSection conversation={makeConversation()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders core launch params when present', () => {
    const conv = makeConversation({
      launchConfig: { headless: true, permissionMode: 'acceptEdits', autocompactPct: 80 },
    } as unknown as Partial<Conversation>)
    render(<LaunchParamsSection conversation={conv} />)
    expect(screen.getByText('Launch')).toBeDefined()
    expect(screen.getByText('headless')).toBeDefined()
    expect(screen.getByText('acceptEdits')).toBeDefined()
    expect(screen.getByText('80%')).toBeDefined()
  })

  it('masks secret env vars by default and reveals on toggle', () => {
    const conv = makeConversation({
      launchConfig: { env: { API_TOKEN: 'sk-abcdefghijklmnop', SAFE_VAR: 'plain' } },
    } as unknown as Partial<Conversation>)
    render(<LaunchParamsSection conversation={conv} />)
    // Plain var visible
    expect(screen.getByText('plain')).toBeDefined()
    // Secret masked (no raw token visible)
    expect(screen.queryByText('sk-abcdefghijklmnop')).toBeNull()
    // Toggle reveal
    fireEvent.click(screen.getByRole('button', { name: /reveal secrets/i }))
    expect(screen.getByText('sk-abcdefghijklmnop')).toBeDefined()
    // Toggle hide
    fireEvent.click(screen.getByRole('button', { name: /hide secrets/i }))
    expect(screen.queryByText('sk-abcdefghijklmnop')).toBeNull()
  })

  it('stops click propagation on reveal toggle so the surrounding row does not navigate', () => {
    const conv = makeConversation({
      launchConfig: { env: { TOKEN: 'sk-abcdef' } },
    } as unknown as Partial<Conversation>)
    let outerClicked = false
    const { container } = render(
      <div onClick={() => (outerClicked = true)}>
        <LaunchParamsSection conversation={conv} />
      </div>,
    )
    const btn = container.querySelector('button')
    if (btn) fireEvent.click(btn)
    expect(outerClicked).toBe(false)
  })
})
