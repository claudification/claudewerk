/**
 * A Stop hook that blocks the turn is machinery, and its feedback reaches the transcript as a
 * plain Claude Code USER entry -- the grouper synthesizes the system group around it and puts
 * the subtype on the GROUP. Two things must hold: the line says what happened (never the
 * registry's `[user]` fallback, which is what shipped), and our own set_status nudge stays a
 * quiet label instead of 160 amber characters of prose aimed at the agent.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import type { DisplayGroup } from './grouping'
import { SystemLine } from './system-line'

afterEach(cleanup)

const NUDGE = `Stop hook feedback:
You did real work this turn but never called set_status. Make the call: if this rises to a triage-worthy state -- you FINISHED what the user asked, you're BLOCKED on the user, or you're STUCK on something else -- set one so the user can triage this conversation at a glance:

  set_status({ state: 'working' | 'done' | 'needs_you' | 'blocked', ... })

Keep the text fields sparse -- empty is fine, only fill what matters.`

function group(text: string): DisplayGroup {
  return {
    type: 'system',
    timestamp: '2026-08-05T13:44:02.083Z',
    systemSubtype: 'hook_feedback',
    entries: [
      {
        type: 'user',
        timestamp: '2026-08-05T13:44:02.083Z',
        uuid: 'b9a9191d-186f-4482-85da-5f52b0f56051',
        isMeta: true,
        seq: 307,
        message: { role: 'user', content: [{ type: 'text', text }] },
      },
    ],
  } as unknown as DisplayGroup
}

describe('hook feedback line', () => {
  test('our set_status nudge collapses to one muted label', () => {
    render(<SystemLine group={group(NUDGE)} ts="2026-08-05T13:44:02.083Z" />)
    const line = screen.getByText('Stop hook: set_status nudge')
    // `text-muted-foreground/70` before the opacity tokens landed.
    expect(line.className).toContain('text-fg-muted')
    expect(screen.queryByText(/triage-worthy/)).toBeNull()
  })

  test('a foreign hook still says what it complained about', () => {
    render(<SystemLine group={group('SubagentStop hook feedback:\nTests are failing.')} ts={0} />)
    expect(screen.getByText('SubagentStop hook: Tests are failing.').className).toContain('text-amber')
  })

  test('never renders the unclaimed-kind fallback for a synthesized group', () => {
    render(<SystemLine group={group(NUDGE)} ts={0} />)
    expect(screen.queryByText('[user]')).toBeNull()
  })
})
