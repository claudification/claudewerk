import { describe, expect, it } from 'bun:test'
import { describeEvent, isHiddenEvent, visibilityOf } from './index'
import type { EventLine } from './types'

/** Describes a `type: "system"` entry and asserts it produced a line. */
function sys(subtype: string, fields: Record<string, unknown> = {}): EventLine {
  const line = describeEvent({ ...fields, type: 'system', subtype })
  expect(line, `system/${subtype} rendered nothing`).not.toBeNull()
  return line as EventLine
}

/** Describes a top-level entry and asserts it produced a line. */
function top(type: string, fields: Record<string, unknown> = {}): EventLine {
  const line = describeEvent({ ...fields, type })
  expect(line, `${type} rendered nothing`).not.toBeNull()
  return line as EventLine
}

describe('vcs-changed', () => {
  it('labels each known kind', () => {
    expect(sys('vcs_state_changed', { kind: 'commit' }).text).toBe('Committed')
    expect(sys('vcs_state_changed', { kind: 'push' }).text).toBe('Pushed')
    expect(sys('vcs_state_changed', { kind: 'merge' }).text).toBe('Merged')
    expect(sys('vcs_state_changed', { kind: 'rebase' }).text).toBe('Rebased')
  })

  it('still renders an unrecognized kind -- the backend calls the set open', () => {
    expect(sys('vcs_state_changed', { kind: 'cherry_pick' }).text).toBe('Repo: cherry_pick')
  })

  it('renders with no kind at all, and never as a raw wire key', () => {
    expect(sys('vcs_state_changed').text).toBe('Repo state changed')
    expect(sys('vcs_state_changed', { kind: 'push' }).text).not.toContain('[')
  })
})

describe('code-published -- one kind, two wire shapes', () => {
  it('reads the mid-stream frame', () => {
    const line = sys('code_change_published', {
      provider: 'github',
      url: 'https://github.com/o/n/pull/7',
      repo: 'o/n',
      identifier: '7',
    })
    expect(line.text).toBe('PR #7 -- o/n')
    expect(line.href).toBe('https://github.com/o/n/pull/7')
  })

  it('reads the JSONL pr-link entry the same way', () => {
    const line = top('pr-link', {
      prUrl: 'https://github.com/claudification/remote-claude/pull/46',
      prNumber: 46,
      prRepository: 'claudification/remote-claude',
    })
    expect(line.text).toBe('PR #46 -- claudification/remote-claude')
    expect(line.href).toBe('https://github.com/claudification/remote-claude/pull/46')
  })

  it('calls it an MR on gitlab', () => {
    expect(sys('code_change_published', { provider: 'gitlab', repo: 'g/s/n', identifier: '3' }).text).toBe(
      'MR #3 -- g/s/n',
    )
  })

  it('falls back to the url when the scrape produced no id/repo', () => {
    expect(sys('code_change_published', { url: 'https://x/y/pull/1' }).text).toBe('https://x/y/pull/1')
  })
})

describe('api-error -- one kind, every backend dialect', () => {
  // Regression: this is force-forwarded live in headless, but its message lives at
  // error.formatted -- not `content` -- so every API failure rendered as a bare gray token
  // with the reason dropped.
  it('reads the structured error', () => {
    const line = sys('api_error', { error: { formatted: 'Overloaded', status: 529, message: 'raw' } })
    expect(line.text).toBe('API error 529: Overloaded')
    expect(line.severity).toBe('error')
  })

  it('falls back to error.message', () => {
    expect(sys('api_error', { error: { message: 'socket hang up' } }).text).toBe('API error: socket hang up')
  })

  it('reads the chat-api / ACP dialect, which puts it at content', () => {
    expect(sys('chat_api_error', { content: 'upstream refused' }).text).toBe('API error: upstream refused')
  })

  it('names a network outage', () => {
    const line = sys('api_error', { error: { is_network_down: true, connection: { code: 'ENOTFOUND' } } })
    expect(line.text).toBe('Network down: ENOTFOUND')
  })

  it('survives an entry with no error object', () => {
    expect(sys('api_error').text).toBe('API error: API error')
  })
})

describe('api-retry', () => {
  it('renders a retry with its attempt and delay', () => {
    expect(sys('api_retry', { attempt: 2, max_retries: 5, error_status: 529, retry_delay_ms: 1500 }).text).toBe(
      'API retry 2/5 (529) - retrying in 2s',
    )
  })

  it('stays silent on the control-request frame that only says "started"', () => {
    expect(describeEvent({ type: 'system', subtype: 'control_request_progress', status: 'started' })).toBeNull()
  })

  it('renders the control-request frame once it actually retries', () => {
    expect(sys('control_request_progress', { status: 'api_retry', attempt: 1 }).text).toContain('API retry 1')
  })
})

describe('model refusal / consent / mismatch', () => {
  it('renders a refusal that fell back', () => {
    expect(
      sys('model_refusal_fallback', {
        original_model: 'opus',
        fallback_model: 'sonnet',
        api_refusal_category: 'cyber',
        direction: 'retry',
      }).text,
    ).toBe('Model refusal: opus -> sonnet (cyber, retry)')
  })

  it('renders a refusal with no retry', () => {
    expect(
      sys('model_refusal_no_fallback', { api_refusal_category: 'bio', api_refusal_explanation: 'nope' }).text,
    ).toBe('Model refused (bio), no fallback: nope')
  })

  it('renders a consent-gated swap', () => {
    expect(
      sys('model_consent_fallback', {
        choice: 'cancelled',
        original_model: 'fable',
        fallback_model: 'opus',
        persisted_as_default: true,
      }).text,
    ).toBe('Model consent cancelled: fable -> opus, saved as default')
  })

  it('honors the level on our own model_mismatch', () => {
    const line = sys('model_mismatch', {
      content: 'Model mismatch: requested fable but CC used opus',
      level: 'warning',
    })
    expect(line.severity).toBe('warn')
    expect(line.text).toContain('requested fable')
  })
})

describe('host lifecycle', () => {
  it('shows why the worker went away', () => {
    expect(sys('worker_shutting_down', { reason: 'host_exit' }).text).toBe('Worker shutting down: host_exit')
    expect(sys('worker_shutting_down').text).toBe('Worker shutting down')
  })

  it('names the worktree a conversation entered', () => {
    const line = top('worktree-state', {
      worktreeSession: { worktreeName: 'canvas-picker-search', worktreePath: '/r/.claude/worktrees/x' },
    })
    expect(line.text).toBe('Worktree: canvas-picker-search')
  })

  it('falls back to the last path segment when the name is missing', () => {
    expect(top('worktree-state', { worktreeSession: { worktreePath: '/r/.claude/worktrees/fix-thing' } }).text).toBe(
      'Worktree: fix-thing',
    )
  })

  it('reports a relocation by directory name', () => {
    expect(top('relocated', { relocatedCwd: '/Users/j/projects/remote-claude' }).text).toBe('Moved to remote-claude')
  })
})

describe('permission + interaction mode', () => {
  it('names bypass in words, and warns', () => {
    const line = top('permission-mode', { permissionMode: 'bypassPermissions' })
    expect(line.text).toBe('Permissions bypassed')
    expect(line.severity).toBe('warn')
  })

  it('renders an unknown mode rather than dropping it', () => {
    expect(top('permission-mode', { permissionMode: 'someFutureMode' }).text).toBe('Permission mode: someFutureMode')
  })

  it('stays silent on the resting interaction mode every conversation reports', () => {
    expect(describeEvent({ type: 'mode', mode: 'normal' })).toBeNull()
    expect(top('mode', { mode: 'bash' }).text).toBe('Mode: bash')
  })
})

describe('hooks', () => {
  it('renders nothing on success -- hook-ran already drew the line', () => {
    expect(describeEvent({ type: 'system', subtype: 'hook_response', outcome: 'success' })).toBeNull()
  })

  it('renders a failure with its exit code and first stderr line', () => {
    const line = sys('hook_response', {
      outcome: 'error',
      hook_name: 'guard-bash',
      exit_code: 2,
      stderr: 'denied: sed\nsecond line',
    })
    expect(line.text).toBe('Hook guard-bash error (exit 2): denied: sed')
    expect(line.severity).toBe('error')
  })

  it('renders a cancellation as a warning', () => {
    expect(sys('hook_response', { outcome: 'cancelled', hook_name: 'h' }).severity).toBe('warn')
  })
})

describe('hook-feedback -- a blocked stop, carried on a user entry', () => {
  /** The grouper's synthesized shape: subtype set, reason in message.content text blocks. */
  const feedback = (text: string): EventLine =>
    sys('hook_feedback', { message: { role: 'user', content: [{ type: 'text', text }] } })

  it('collapses our own set_status nudge to one muted label', () => {
    const line = feedback(
      "Stop hook feedback:\nYou did real work this turn but never called set_status. Make the call: if this rises to a triage-worthy state -- you FINISHED what the user asked, you're BLOCKED on the user, or you're STUCK on something else -- set one so the user can triage this conversation at a glance:\n\n  set_status({ state: 'working' | 'done' | 'needs_you' | 'blocked', ... })\n\nKeep the text fields sparse -- empty is fine.",
    )
    expect(line.text).toBe('Stop hook: set_status nudge')
    expect(line.severity).toBe('muted')
  })

  it('keeps a foreign hook loud, but only its first line', () => {
    const line = feedback('SubagentStop hook feedback:\nTests are failing.\nRun bun test first.')
    expect(line.text).toBe('SubagentStop hook: Tests are failing.')
    expect(line.severity).toBe('warn')
  })

  it('survives a reason-less payload without printing a wire key', () => {
    expect(feedback('Stop hook feedback:').text).toBe('Stop hook')
  })

  it('reads a string content payload too, not just text blocks', () => {
    const line = sys('hook_feedback', {
      message: { role: 'user', content: 'Stop hook feedback:\nnever called set_status here' },
    })
    expect(line.severity).toBe('muted')
  })
})

describe('task-updated', () => {
  it('reads the newer patch shape and the older top-level one', () => {
    expect(sys('task_updated', { patch: { description: 'compiling' } }).text).toBe('Task: compiling')
    expect(sys('task_updated', { patch: { error: 'boom' } }).text).toBe('Task error: boom')
    expect(sys('task_updated', { description: 'legacy' }).text).toBe('Task: legacy')
  })
})

describe('severity from the backend own level', () => {
  it('colors a warning differently from an info', () => {
    expect(sys('informational', { content: 'careful', level: 'warning' }).severity).toBe('warn')
    expect(sys('informational', { content: 'fyi', level: 'info' }).severity).toBe('info')
    expect(sys('informational', { content: 'fyi' }).severity).toBe('info')
  })
})

describe('hidden kinds', () => {
  it('hides the high-volume noise that used to draw gray junk lines', () => {
    // 1.9k rows of `[thinking_tokens]`, 148 of `[commands_changed]`.
    expect(isHiddenEvent({ type: 'system', subtype: 'thinking_tokens' })).toBe(true)
    expect(isHiddenEvent({ type: 'system', subtype: 'commands_changed' })).toBe(true)
    expect(isHiddenEvent({ type: 'system', subtype: 'status' })).toBe(true)
    expect(describeEvent({ type: 'system', subtype: 'thinking_tokens' })).toBeNull()
  })

  it('hides the metadata types that used to eat the progressive window budget', () => {
    for (const type of ['attachment', 'custom-title', 'ai-title', 'agent-name', 'file-history-snapshot'])
      expect(isHiddenEvent({ type }), `${type} should be hidden`).toBe(true)
  })

  it('hides the opening frame of every bracketed pair', () => {
    expect(isHiddenEvent({ type: 'system', subtype: 'hook_started' })).toBe(true)
    expect(isHiddenEvent({ type: 'system', subtype: 'task_started' })).toBe(true)
  })

  it('keeps the frames that carry an outcome visible', () => {
    for (const subtype of ['hook_response', 'vcs_state_changed', 'api_error', 'worker_shutting_down'])
      expect(isHiddenEvent({ type: 'system', subtype }), `${subtype} should render`).toBe(false)
  })

  it('leaves the message path alone', () => {
    expect(isHiddenEvent({ type: 'user' })).toBe(false)
    expect(isHiddenEvent({ type: 'assistant' })).toBe(false)
    expect(isHiddenEvent({ type: 'boot' })).toBe(false)
  })
})

describe('cards', () => {
  it('routes the two bordered kinds to a card', () => {
    expect(visibilityOf({ type: 'system', subtype: 'away_summary' })).toBe('card')
    expect(visibilityOf({ type: 'system', subtype: 'background_tasks_changed' })).toBe('card')
  })
})

describe('unknown events', () => {
  it('keeps a subtype shipped ahead of us visible rather than dropping it', () => {
    expect(sys('some_future_subtype').text).toBe('[system/some_future_subtype]')
    expect(sys('some_future_subtype', { content: 'hi' }).text).toBe('hi')
  })
})
