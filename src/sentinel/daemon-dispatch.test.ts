import { describe, expect, it } from 'bun:test'
import type { DaemonResponse } from '../shared/cc-daemon/types'
import {
  buildDispatchSpec,
  type DispatchSpecOpts,
  daemonJobName,
  evaluateAttachPresence,
  modeDispatchesWorker,
  validateDaemonConfigPaths,
} from './daemon-dispatch'

/** Minted worker identity shared by the buildDispatchSpec cases. */
const ID = { short: 'cb2892db', nonce: '08c8b601', sessionId: 'df140babfa311efb1c4c30f77e6d231d' }

/** Thinking summaries default ON, so every worker argv carries the opt-in
 *  unless `thinkingSummaries:false` is passed. See thinking-display.ts. */
const TD_FLAGS = ['--thinking-display', 'summarized'] as const

function specOpts(overrides: Partial<DispatchSpecOpts> = {}): DispatchSpecOpts {
  return { mode: 'new', ...ID, cwd: '/tmp/probe', ...overrides }
}

describe('buildDispatchSpec -- common fields', () => {
  it('stamps source:fleet, isolation:none, and the minted identity', () => {
    const spec = buildDispatchSpec(specOpts({ prompt: 'do the thing' }))
    expect(spec.source).toBe('fleet')
    expect(spec.isolation).toBe('none')
    expect(spec.short).toBe(ID.short)
    expect(spec.nonce).toBe(ID.nonce)
    expect(spec.sessionId).toBe(ID.sessionId)
    expect(spec.cwd).toBe('/tmp/probe')
    expect(typeof spec.createdAt).toBe('number')
  })

  it('passes the worker env delta through verbatim (defaults to {})', () => {
    expect(buildDispatchSpec(specOpts({ prompt: 'x' })).env).toEqual({})
    expect(buildDispatchSpec(specOpts({ prompt: 'x', env: { CLAUDE_CONFIG_DIR: '/d' } })).env).toEqual({
      CLAUDE_CONFIG_DIR: '/d',
    })
  })
})

describe('buildDispatchSpec -- NEW mode', () => {
  it('puts a bare prompt as the only launch.args element', () => {
    const spec = buildDispatchSpec(specOpts({ prompt: 'do the thing' }))
    expect(spec.launch).toEqual({ mode: 'prompt', args: [...TD_FLAGS, 'do the thing'] })
    expect(spec.respawnFlags).toEqual([...TD_FLAGS])
  })

  it('orders --model/--settings/--mcp-config/--append-system-prompt flags before the prompt', () => {
    const spec = buildDispatchSpec(
      specOpts({
        prompt: 'go',
        model: 'claude-haiku-4-5-20251001',
        settingsPath: '/abs/settings.json',
        mcpConfigPath: '/abs/mcp.json',
        appendSystemPrompt: 'reply PROBE-OK',
      }),
    )
    const flags = [
      '--model',
      'claude-haiku-4-5-20251001',
      ...TD_FLAGS,
      '--settings',
      '/abs/settings.json',
      '--mcp-config',
      '/abs/mcp.json',
      '--append-system-prompt',
      'reply PROBE-OK',
    ]
    expect(spec.launch).toEqual({ mode: 'prompt', args: [...flags, 'go'] })
    // respawnFlags are the flags WITHOUT the prompt (reused on respawn).
    expect(spec.respawnFlags).toEqual(flags)
  })

  it('leads with the host --mcp-config, appending the caller mcp-config (variadic, merges)', () => {
    const spec = buildDispatchSpec(
      specOpts({ prompt: 'go', hostMcpConfigPath: '/abs/host-mcp.json', mcpConfigPath: '/abs/user-mcp.json' }),
    )
    expect(spec.launch).toEqual({
      mode: 'prompt',
      args: [...TD_FLAGS, '--mcp-config', '/abs/host-mcp.json', '/abs/user-mcp.json', 'go'],
    })
  })

  it('emits the host --mcp-config alone when no caller mcp-config is supplied', () => {
    const spec = buildDispatchSpec(specOpts({ hostMcpConfigPath: '/abs/host-mcp.json' }))
    expect(spec.launch).toEqual({ mode: 'prompt', args: [...TD_FLAGS, '--mcp-config', '/abs/host-mcp.json'] })
  })

  it('supports a PROMPTLESS dispatch -- empty launch.args when no prompt', () => {
    const spec = buildDispatchSpec(specOpts({ model: 'm' }))
    expect(spec.launch).toEqual({ mode: 'prompt', args: ['--model', 'm', ...TD_FLAGS] })
  })

  it('treats a whitespace-only prompt as absent', () => {
    const spec = buildDispatchSpec(specOpts({ prompt: '   ', model: 'm' }))
    expect(spec.launch).toEqual({ mode: 'prompt', args: ['--model', 'm', ...TD_FLAGS] })
  })

  it('derives seed.name from the conversation name and seed.intent from the prompt', () => {
    const spec = buildDispatchSpec(specOpts({ prompt: 'go', name: 'My Conv' }))
    expect(spec.seed).toEqual({ intent: 'go', name: 'cw-My-Conv' })
  })

  it('defaults seed.intent to claudewerk for a promptless NEW dispatch with no name', () => {
    expect(buildDispatchSpec(specOpts()).seed).toEqual({ intent: 'claudewerk' })
  })

  it('opts INTO thinking summaries by default (CC redacts thinking otherwise)', () => {
    expect(buildDispatchSpec(specOpts()).respawnFlags).toEqual(['--thinking-display', 'summarized'])
    expect(buildDispatchSpec(specOpts({ thinkingSummaries: true })).respawnFlags).toEqual([
      '--thinking-display',
      'summarized',
    ])
  })

  it('emits NO thinking-display flag when summaries are turned off', () => {
    // `omitted` is already CC's own default, so the off state passes no flag at
    // all -- which also keeps it working on a claude too old to know the flag.
    expect(buildDispatchSpec(specOpts({ thinkingSummaries: false })).respawnFlags).toEqual([])
    expect(buildDispatchSpec(specOpts({ thinkingSummaries: false, model: 'm' })).respawnFlags).toEqual(['--model', 'm'])
  })
})

describe('buildDispatchSpec -- RESUME mode', () => {
  it('emits a resume launch with fork:true and the flags in flagArgs', () => {
    const spec = buildDispatchSpec(
      specOpts({ mode: 'resume', resumeSessionId: '27dc07b0-cafe', model: 'm', prompt: 'next turn' }),
    )
    expect(spec.launch).toEqual({
      mode: 'resume',
      sessionId: '27dc07b0-cafe',
      fork: true,
      flagArgs: ['--model', 'm', ...TD_FLAGS, 'next turn'],
    })
  })

  it('drops the trailing prompt positional when resume has no prompt', () => {
    const spec = buildDispatchSpec(specOpts({ mode: 'resume', resumeSessionId: 'sess-1', model: 'm' }))
    expect(spec.launch).toEqual({
      mode: 'resume',
      sessionId: 'sess-1',
      fork: true,
      flagArgs: ['--model', 'm', ...TD_FLAGS],
    })
  })

  it('defaults seed.intent to resume when a resume carries no prompt', () => {
    expect(buildDispatchSpec(specOpts({ mode: 'resume', resumeSessionId: 'sess-1' })).seed).toEqual({
      intent: 'resume',
    })
  })

  it('throws when resume mode has no resumeSessionId', () => {
    expect(() => buildDispatchSpec(specOpts({ mode: 'resume', prompt: 'x' }))).toThrow(/resume mode requires/)
  })
})

describe('daemonJobName', () => {
  it('prefixes cw- and collapses non-alphanumeric runs to a single hyphen', () => {
    expect(daemonJobName('My Conv / test!!')).toBe('cw-My-Conv-test-')
  })

  it('caps the slug at 40 chars', () => {
    expect(daemonJobName('a'.repeat(100)).length).toBe(43) // 'cw-' + 40
  })
})

describe('validateDaemonConfigPaths', () => {
  const allMissing = () => false
  const allPresent = () => true

  it('passes when no paths are supplied', () => {
    expect(validateDaemonConfigPaths({}, allMissing).ok).toBe(true)
  })

  it('passes when supplied paths exist', () => {
    const check = validateDaemonConfigPaths({ settingsPath: '/s.json', mcpConfigPath: '/m.json' }, allPresent)
    expect(check.ok).toBe(true)
  })

  it('fails with a clear message when --settings is missing', () => {
    const check = validateDaemonConfigPaths({ settingsPath: '/nope.json' }, allMissing)
    expect(check.ok).toBe(false)
    expect(check.error).toContain('/nope.json')
  })

  it('fails when --mcp-config is missing', () => {
    const check = validateDaemonConfigPaths({ mcpConfigPath: '/nope.json' }, p => p !== '/nope.json')
    expect(check.ok).toBe(false)
    expect(check.error).toContain('mcp-config')
  })
})

describe('evaluateAttachPresence -- ATTACH short-circuit gate', () => {
  it('passes when the worker is present', () => {
    const resp = { ok: true, op: 'has', present: true, alive: true } as unknown as DaemonResponse
    expect(evaluateAttachPresence(resp, 'aeb185f9').ok).toBe(true)
  })

  it('fails when the worker is not present in the roster', () => {
    const resp = { ok: true, op: 'has', present: false, alive: false } as unknown as DaemonResponse
    const check = evaluateAttachPresence(resp, 'aeb185f9')
    expect(check.ok).toBe(false)
    expect(check.error).toContain('aeb185f9')
  })

  it('fails when the daemon `has` op returned an error', () => {
    const resp: DaemonResponse = { ok: false, error: 'no such job', code: 'ENOJOB' }
    const check = evaluateAttachPresence(resp, 'deadbeef')
    expect(check.ok).toBe(false)
    expect(check.error).toContain('ENOJOB')
  })
})

describe('modeDispatchesWorker -- which modes dispatch a worker', () => {
  it('NEW and RESUME dispatch a worker', () => {
    expect(modeDispatchesWorker('new')).toBe(true)
    expect(modeDispatchesWorker('resume')).toBe(true)
  })

  it('ATTACH does not dispatch -- it short-circuits to the roster short', () => {
    expect(modeDispatchesWorker('attach')).toBe(false)
  })
})
