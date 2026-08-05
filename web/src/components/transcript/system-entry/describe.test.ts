import { describe, expect, it } from 'vitest'
import { NOISE_SYSTEM_SUBTYPES } from '../grouping/parsers'
import { describeSystemEntry } from './index'
import type { TextResult } from './types'

/** Describes an entry and asserts it produced a text line (not a card / null). */
function text(subtype: string, entry: Record<string, unknown> = {}): TextResult {
  const result = describeSystemEntry(subtype, { ...entry, type: 'system', subtype })
  expect(result, `${subtype} rendered nothing`).not.toBeNull()
  expect(result?.kind).toBe('text')
  return result as TextResult
}

describe('vcs_state_changed', () => {
  it('labels each known kind', () => {
    expect(text('vcs_state_changed', { kind: 'commit' }).text).toBe('Committed')
    expect(text('vcs_state_changed', { kind: 'push' }).text).toBe('Pushed')
    expect(text('vcs_state_changed', { kind: 'merge' }).text).toBe('Merged')
    expect(text('vcs_state_changed', { kind: 'rebase' }).text).toBe('Rebased')
  })

  it('still renders an unrecognized kind -- CC calls the set open', () => {
    expect(text('vcs_state_changed', { kind: 'cherry_pick' }).text).toBe('Repo: cherry_pick')
  })

  it('renders with no kind at all', () => {
    expect(text('vcs_state_changed').text).toBe('Repo state changed')
  })

  it('never falls through to the raw [subtype] fallback', () => {
    expect(text('vcs_state_changed', { kind: 'push' }).text).not.toContain('[vcs_state_changed]')
  })
})

describe('code_change_published', () => {
  it('renders the PR number, repo and a link', () => {
    const r = text('code_change_published', {
      provider: 'github',
      url: 'https://github.com/o/n/pull/7',
      repo: 'o/n',
      identifier: '7',
    })
    expect(r.text).toBe('PR #7 -- o/n')
    expect(r.href).toBe('https://github.com/o/n/pull/7')
  })

  it('calls it an MR on gitlab', () => {
    expect(text('code_change_published', { provider: 'gitlab', repo: 'g/s/n', identifier: '3' }).text).toBe(
      'MR #3 -- g/s/n',
    )
  })

  it('falls back to the url when the scrape produced no id/repo', () => {
    expect(text('code_change_published', { url: 'https://x/y/pull/1' }).text).toBe('https://x/y/pull/1')
  })
})

describe('api_error', () => {
  // Regression: api_error is force-forwarded live in headless
  // (HEADLESS_LIVE_SYSTEM_SUBTYPES) but had no arm, and its message lives at
  // error.formatted -- not `content` -- so every API failure rendered as a bare
  // gray "[api_error]" with the reason dropped.
  it('renders the formatted message and status instead of [api_error]', () => {
    const r = text('api_error', { error: { formatted: 'Overloaded', status: 529, message: 'raw' } })
    expect(r.text).toBe('API error 529: Overloaded')
    expect(r.color).toContain('red')
  })

  it('falls back to error.message', () => {
    expect(text('api_error', { error: { message: 'socket hang up' } }).text).toBe('API error: socket hang up')
  })

  it('names a network outage', () => {
    const r = text('api_error', { error: { is_network_down: true, connection: { code: 'ENOTFOUND' } } })
    expect(r.text).toBe('Network down: ENOTFOUND')
  })

  it('survives an entry with no error object', () => {
    expect(text('api_error').text).toBe('API error: API error')
  })
})

describe('model refusal / consent', () => {
  it('renders a refusal that fell back', () => {
    const r = text('model_refusal_fallback', {
      original_model: 'opus',
      fallback_model: 'sonnet',
      api_refusal_category: 'cyber',
      direction: 'retry',
    })
    expect(r.text).toBe('Model refusal: opus -> sonnet (cyber, retry)')
  })

  it('renders a refusal with no retry', () => {
    const r = text('model_refusal_no_fallback', { api_refusal_category: 'bio', api_refusal_explanation: 'nope' })
    expect(r.text).toBe('Model refused (bio), no fallback: nope')
  })

  it('renders a consent-gated swap', () => {
    const r = text('model_consent_fallback', {
      choice: 'cancelled',
      original_model: 'fable',
      fallback_model: 'opus',
      persisted_as_default: true,
    })
    expect(r.text).toBe('Model consent cancelled: fable -> opus, saved as default')
  })
})

describe('worker_shutting_down', () => {
  it('shows the reason the host gave', () => {
    expect(text('worker_shutting_down', { reason: 'host_exit' }).text).toBe('Worker shutting down: host_exit')
  })

  it('renders without a reason', () => {
    expect(text('worker_shutting_down').text).toBe('Worker shutting down')
  })
})

describe('hook_response', () => {
  it('renders nothing on success -- hook_progress already drew the line', () => {
    expect(describeSystemEntry('hook_response', { outcome: 'success', hook_name: 'guard' })).toBeNull()
  })

  it('renders a failure with its exit code and first stderr line', () => {
    const r = text('hook_response', {
      outcome: 'error',
      hook_name: 'guard-bash',
      exit_code: 2,
      stderr: 'denied: sed\nsecond line',
    })
    expect(r.text).toBe('Hook guard-bash error (exit 2): denied: sed')
    expect(r.color).toContain('red')
  })

  it('renders a cancellation in amber', () => {
    expect(text('hook_response', { outcome: 'cancelled', hook_name: 'h' }).color).toContain('amber')
  })
})

describe('task_updated', () => {
  it('reads the CC 2.1.221 patch shape', () => {
    expect(text('task_updated', { patch: { description: 'compiling' } }).text).toBe('Task: compiling')
    expect(text('task_updated', { patch: { error: 'boom' } }).text).toBe('Task error: boom')
  })

  it('still reads the older top-level shape', () => {
    expect(text('task_updated', { description: 'legacy' }).text).toBe('Task: legacy')
  })
})

describe('informational levels', () => {
  it('colors a warning differently from an info', () => {
    expect(text('informational', { content: 'careful', level: 'warning' }).color).toContain('amber')
    expect(text('informational', { content: 'fyi', level: 'info' }).color).toContain('cyan')
    expect(text('informational', { content: 'fyi' }).color).toContain('cyan')
  })
})

describe('local_command_output', () => {
  it('renders the command output text', () => {
    expect(text('local_command_output', { content: '3h left' }).text).toBe('3h left')
  })

  it('renders nothing when empty', () => {
    expect(describeSystemEntry('local_command_output', { content: '   ' })).toBeNull()
  })
})

describe('fallback', () => {
  it('keeps an unknown subtype visible rather than dropping it', () => {
    expect(text('some_future_subtype').text).toBe('[some_future_subtype]')
    expect(text('some_future_subtype', { content: 'hi' }).text).toBe('hi')
  })
})

describe('noise set', () => {
  it('hides the opening frames CC brackets hooks and tasks with', () => {
    expect(NOISE_SYSTEM_SUBTYPES.has('hook_started')).toBe(true)
    expect(NOISE_SYSTEM_SUBTYPES.has('task_started')).toBe(true)
  })

  it('keeps the frames that carry the outcome visible', () => {
    expect(NOISE_SYSTEM_SUBTYPES.has('hook_response')).toBe(false)
    expect(NOISE_SYSTEM_SUBTYPES.has('vcs_state_changed')).toBe(false)
    expect(NOISE_SYSTEM_SUBTYPES.has('api_error')).toBe(false)
  })
})
