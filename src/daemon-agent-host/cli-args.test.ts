/**
 * Tier 1 unit tests for `cli-args` -- daemon-agent-host env-var resolution.
 * Covers the CLAUDWERK_ >> RCLAUDE_ precedence covenant, the defaults, and the
 * launch-mode parsing. The precedence tests drive `parseDaemonHostConfig()`
 * against `process.env`; the mode + required-var tests drive the pure
 * `resolveDaemonHostConfig(env)` so error paths are checked without exiting.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseDaemonHostConfig, resolveDaemonHostConfig } from './cli-args'

/** Env keys this module reads -- saved + restored around every test. */
const KEYS = [
  'CLAUDWERK_BROKER',
  'RCLAUDE_BROKER',
  'CLAUDWERK_SECRET',
  'RCLAUDE_SECRET',
  'RCLAUDE_CONVERSATION_ID',
  'CLAUDWERK_DAEMON_SHORT',
  'RCLAUDE_CWD',
]

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // The two required vars -- set so the happy path does not exit().
  process.env.RCLAUDE_CONVERSATION_ID = 'conv_test'
  process.env.CLAUDWERK_DAEMON_SHORT = 'aaaa1111'
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

test('CLAUDWERK_ prefix wins over the RCLAUDE_ fallback', () => {
  process.env.CLAUDWERK_BROKER = 'ws://canonical:1'
  process.env.RCLAUDE_BROKER = 'ws://legacy:2'
  process.env.CLAUDWERK_SECRET = 'canonical-secret'
  process.env.RCLAUDE_SECRET = 'legacy-secret'
  const cfg = parseDaemonHostConfig()
  expect(cfg.brokerUrl).toBe('ws://canonical:1')
  expect(cfg.brokerSecret).toBe('canonical-secret')
})

test('falls back to the RCLAUDE_ prefix when CLAUDWERK_ is unset', () => {
  process.env.RCLAUDE_BROKER = 'ws://legacy:2'
  process.env.RCLAUDE_SECRET = 'legacy-secret'
  const cfg = parseDaemonHostConfig()
  expect(cfg.brokerUrl).toBe('ws://legacy:2')
  expect(cfg.brokerSecret).toBe('legacy-secret')
})

test('brokerUrl defaults when neither prefix is set; secret may be undefined', () => {
  const cfg = parseDaemonHostConfig()
  expect(cfg.brokerUrl).toBe('ws://localhost:9999')
  expect(cfg.brokerSecret).toBeUndefined()
})

test('carries the required conversationId + daemonShort through', () => {
  const cfg = parseDaemonHostConfig()
  expect(cfg.conversationId).toBe('conv_test')
  expect(cfg.daemonShort).toBe('aaaa1111')
})

test('cwd uses RCLAUDE_CWD when set, else process.cwd()', () => {
  process.env.RCLAUDE_CWD = '/tmp/worker-cwd'
  expect(parseDaemonHostConfig().cwd).toBe('/tmp/worker-cwd')
  delete process.env.RCLAUDE_CWD
  expect(parseDaemonHostConfig().cwd).toBe(process.cwd())
})

// ---------------------------------------------------------------------------
// resolveDaemonHostConfig -- the pure resolver: launch mode + required vars.
// ---------------------------------------------------------------------------

/** A minimal env that resolves successfully in `new` mode. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    RCLAUDE_CONVERSATION_ID: 'conv_test',
    CLAUDWERK_DAEMON_SHORT: 'aaaa1111',
    ...extra,
  }
}

/** Unwrap a successful result or fail the test loudly. */
function expectOk(result: ReturnType<typeof resolveDaemonHostConfig>) {
  if (!result.ok) throw new Error(`expected ok config, got error: ${result.error}`)
  return result.config
}

describe('resolveDaemonHostConfig -- launch mode', () => {
  test('mode defaults to new when CLAUDWERK_DAEMON_MODE is unset', () => {
    const cfg = expectOk(resolveDaemonHostConfig(baseEnv()))
    expect(cfg.mode).toBe('new')
    expect(cfg.resumeSessionId).toBeUndefined()
  })

  test('parses mode=attach', () => {
    const cfg = expectOk(resolveDaemonHostConfig(baseEnv({ CLAUDWERK_DAEMON_MODE: 'attach' })))
    expect(cfg.mode).toBe('attach')
  })

  test('parses mode=resume and carries the resume session id', () => {
    const cfg = expectOk(
      resolveDaemonHostConfig(
        baseEnv({ CLAUDWERK_DAEMON_MODE: 'resume', CLAUDWERK_DAEMON_RESUME_SESSION: 'sess-to-resume' }),
      ),
    )
    expect(cfg.mode).toBe('resume')
    expect(cfg.resumeSessionId).toBe('sess-to-resume')
  })

  test('rejects an unknown mode value', () => {
    const result = resolveDaemonHostConfig(baseEnv({ CLAUDWERK_DAEMON_MODE: 'bogus' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/new\|resume\|attach/)
  })

  test('resume mode requires CLAUDWERK_DAEMON_RESUME_SESSION', () => {
    const result = resolveDaemonHostConfig(baseEnv({ CLAUDWERK_DAEMON_MODE: 'resume' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/CLAUDWERK_DAEMON_RESUME_SESSION/)
  })

  test('resumeSessionId is dropped for new/attach even if the env var is set', () => {
    const cfg = expectOk(
      resolveDaemonHostConfig(baseEnv({ CLAUDWERK_DAEMON_MODE: 'attach', CLAUDWERK_DAEMON_RESUME_SESSION: 'stray' })),
    )
    expect(cfg.resumeSessionId).toBeUndefined()
  })
})

describe('resolveDaemonHostConfig -- required vars', () => {
  test('CLAUDWERK_DAEMON_SHORT is required in attach mode', () => {
    const env = baseEnv({ CLAUDWERK_DAEMON_MODE: 'attach' })
    delete env.CLAUDWERK_DAEMON_SHORT
    const result = resolveDaemonHostConfig(env)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/CLAUDWERK_DAEMON_SHORT/)
  })

  test('CLAUDWERK_DAEMON_SHORT is required in new mode too', () => {
    const env = baseEnv()
    delete env.CLAUDWERK_DAEMON_SHORT
    const result = resolveDaemonHostConfig(env)
    expect(result.ok).toBe(false)
  })

  test('RCLAUDE_CONVERSATION_ID is required', () => {
    const env = baseEnv()
    delete env.RCLAUDE_CONVERSATION_ID
    const result = resolveDaemonHostConfig(env)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/RCLAUDE_CONVERSATION_ID/)
  })
})
