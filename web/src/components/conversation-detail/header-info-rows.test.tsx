/**
 * LaunchConfigRow -- the read-only "Launch config" disclosure shown for
 * daemon-backed conversations (plan Phase F, Section 4.3).
 */

import type { LaunchConfig } from '@shared/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import type { Conversation } from '@/lib/types'
import { LaunchConfigRow } from './header-info-rows'

afterEach(cleanup)

/** A conversation carrying just the launchConfig the row reads. */
function conv(launchConfig?: LaunchConfig): Conversation {
  return { launchConfig } as unknown as Conversation
}

/** A conversation with a top-level transport (transport reframe Phase 5). */
function convWithTransport(transport: string, launchConfig?: LaunchConfig): Conversation {
  return { transport, launchConfig } as unknown as Conversation
}

describe('LaunchConfigRow', () => {
  test('renders nothing for a conversation with no launchConfig', () => {
    const { container } = render(<LaunchConfigRow conversation={conv()} />)
    expect(container.firstChild).toBeNull()
  })

  test('renders nothing for a non-daemon launchConfig (no daemonMode)', () => {
    const { container } = render(<LaunchConfigRow conversation={conv({ headless: true, model: 'claude-haiku-4-5' })} />)
    expect(container.firstChild).toBeNull()
  })

  test('shows the daemon mode summary for a daemon conversation', () => {
    render(<LaunchConfigRow conversation={conv({ headless: false, agentHostType: 'daemon', daemonMode: 'resume' })} />)
    expect(screen.getByText('Launch config')).toBeDefined()
    expect(screen.getByText('daemon · resume')).toBeDefined()
  })

  test('is collapsed by default and expands on click', () => {
    render(
      <LaunchConfigRow
        conversation={conv({
          headless: false,
          agentHostType: 'daemon',
          daemonMode: 'new',
          model: 'claude-opus-4-7',
          daemonSettingsPath: '/etc/claude/settings.json',
        })}
      />,
    )
    // Collapsed: detail rows not in the DOM.
    expect(screen.queryByText('settings')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('settings')).toBeDefined()
    expect(screen.getByText('/etc/claude/settings.json')).toBeDefined()
    expect(screen.getByText('claude-opus-4-7')).toBeDefined()
  })

  test('shows env keys but never env values', () => {
    render(
      <LaunchConfigRow
        conversation={conv({
          headless: false,
          agentHostType: 'daemon',
          daemonMode: 'new',
          env: { API_TOKEN: 'super-secret-value', DEBUG: '1' },
        })}
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('API_TOKEN, DEBUG')).toBeDefined()
    expect(screen.queryByText(/super-secret-value/)).toBeNull()
  })

  test('keys off conv.transport === claude-daemon and surfaces the transport in the summary', () => {
    render(
      <LaunchConfigRow conversation={convWithTransport('claude-daemon', { headless: false, daemonMode: 'new' })} />,
    )
    expect(screen.getByText('Launch config')).toBeDefined()
    expect(screen.getByText('claude-daemon · new')).toBeDefined()
  })

  test('shows a transport row when expanded', () => {
    render(
      <LaunchConfigRow conversation={convWithTransport('claude-daemon', { headless: false, daemonMode: 'new' })} />,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('transport')).toBeDefined()
    // The transport value appears in both the summary and the expanded row.
    expect(screen.getAllByText('claude-daemon').length).toBeGreaterThan(0)
  })

  test('renders nothing for a claude-headless transport (not a daemon)', () => {
    const { container } = render(
      <LaunchConfigRow conversation={convWithTransport('claude-headless', { headless: true })} />,
    )
    expect(container.firstChild).toBeNull()
  })

  test('shows the mcp config path and system prompt suffix when set', () => {
    render(
      <LaunchConfigRow
        conversation={conv({
          headless: false,
          agentHostType: 'daemon',
          daemonMode: 'new',
          daemonMcpConfigPath: '/etc/claude/mcp.json',
          appendSystemPrompt: 'Be terse.',
        })}
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('/etc/claude/mcp.json')).toBeDefined()
    expect(screen.getByText('Be terse.')).toBeDefined()
  })
})
