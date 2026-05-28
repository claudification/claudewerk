/**
 * Regression test for the subagents-prop decoupling.
 *
 * BEFORE: the whole `subagents` array was drilled transcript-view -> GroupView
 * -> ToolItem -> ToolLine as a prop. Its reference churned on every subagent
 * poll (status / eventCount / token updates), busting MemoizedGroupView and
 * MemoizedToolLine fleet-wide -- every group + every tool row re-rendered on
 * every subagent tick, even rows with no subagent content at all.
 *
 * AFTER: the live badge is a self-subscribing leaf (AgentTaskBadge) that
 * subscribes ONLY to its one matching subagent (by description). A subagent
 * update re-renders the matching badge alone; an unrelated row's badge (no
 * match -> selector returns undefined, a primitive -> Object.is stable) does
 * NOT re-render.
 *
 * Profiler.onRender is the render counter: a store update only re-renders
 * components whose selected value actually changed, so a stable-value selector
 * produces zero extra onRender calls for its subtree.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { act, Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { AgentTaskBadge } from './tool-cases-agent'

type Status = 'running' | 'stopped'
function sub(description: string, status: Status) {
  return {
    agentId: `id-${description}`,
    agentType: 'Explore',
    description,
    status,
    startedAt: 1000,
    stoppedAt: status === 'stopped' ? 3000 : undefined,
    eventCount: 2,
  }
}

function setSubagents(subs: ReturnType<typeof sub>[]) {
  act(() => {
    useConversationsStore.setState({
      selectedConversationId: 'conv_test',
      conversationsById: { conv_test: { id: 'conv_test', subagents: subs } } as never,
    })
  })
}

afterEach(cleanup)
beforeEach(() => {
  act(() => {
    useConversationsStore.setState({ selectedConversationId: null, conversationsById: {} } as never)
  })
})

describe('AgentTaskBadge -- self-subscription', () => {
  it('renders the matching subagent and updates live when ITS status changes', () => {
    setSubagents([sub('Find the config', 'running')])
    render(<AgentTaskBadge description="Find the config" />)
    expect(screen.getByTitle('View agent transcript').textContent).toContain('running')

    // The matched subagent flips to stopped -> the badge must reflect it.
    setSubagents([sub('Find the config', 'stopped')])
    expect(screen.getByTitle('View agent transcript').textContent).toContain('done')
  })

  it('renders nothing when no subagent matches the description', () => {
    setSubagents([sub('Some other task', 'running')])
    const { container } = render(<AgentTaskBadge description="My unique desc" />)
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('AgentTaskBadge -- isolation (the decoupling win)', () => {
  it('a non-matching badge does NOT re-render when unrelated subagents churn', () => {
    setSubagents([sub('Some other task', 'running')])
    const onRender = vi.fn()
    render(
      <Profiler id="badge" onRender={onRender}>
        <AgentTaskBadge description="My unique desc" />
      </Profiler>,
    )
    const mountRenders = onRender.mock.calls.length

    // Churn the unrelated subagent hard: new array, new object, status +
    // eventCount changed, plus a second agent appears. None match our desc, so
    // our badge's selector stays undefined (Object.is stable) -> no re-render.
    setSubagents([sub('Some other task', 'stopped'), sub('A third thing', 'running')])
    expect(onRender.mock.calls.length).toBe(mountRenders)
  })

  it('the matching badge DOES re-render when its own subagent churns', () => {
    setSubagents([sub('My task', 'running')])
    const onRender = vi.fn()
    render(
      <Profiler id="badge" onRender={onRender}>
        <AgentTaskBadge description="My task" />
      </Profiler>,
    )
    const mountRenders = onRender.mock.calls.length

    setSubagents([sub('My task', 'stopped')])
    expect(onRender.mock.calls.length).toBeGreaterThan(mountRenders)
  })
})
