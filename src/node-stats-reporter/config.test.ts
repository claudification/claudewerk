import { describe, expect, it } from 'bun:test'
import { backoffMs, parseReporterArgs } from './config'

const RPT = 'rpt_abcdef'

describe('node-stats-reporter config', () => {
  it('takes broker + secret from flags', () => {
    const parsed = parseReporterArgs(['--broker', 'wss://b', '--secret', RPT], {})
    expect(parsed.ok).toBe(true)
    expect(parsed.config?.brokerUrl).toBe('wss://b')
    expect(parsed.config?.secret).toBe(RPT)
  })

  it('takes them from env when no flags are given', () => {
    const parsed = parseReporterArgs([], { CLAUDWERK_BROKER: 'wss://b', CLAUDWERK_REPORTER_SECRET: RPT })
    expect(parsed.ok).toBe(true)
    expect(parsed.config?.brokerUrl).toBe('wss://b')
  })

  it('flags beat env', () => {
    const parsed = parseReporterArgs(['--broker', 'wss://flag'], {
      CLAUDWERK_BROKER: 'wss://env',
      CLAUDWERK_REPORTER_SECRET: RPT,
    })
    expect(parsed.config?.brokerUrl).toBe('wss://flag')
  })

  it('REFUSES to run with a sentinel secret -- a reporter must not hold spawn authority', () => {
    const parsed = parseReporterArgs(['--broker', 'wss://b', '--secret', 'snt_spawnauthority'], {})
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('rpt_')
  })

  it('refuses the admin secret too', () => {
    const parsed = parseReporterArgs(['--broker', 'wss://b', '--secret', 'some-admin-secret'], {})
    expect(parsed.ok).toBe(false)
  })

  it('errors (with usage) when the broker is missing', () => {
    const parsed = parseReporterArgs(['--secret', RPT], {})
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('--broker')
  })

  it('errors when the secret is missing', () => {
    const parsed = parseReporterArgs(['--broker', 'wss://b'], {})
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('--secret')
  })

  it('rejects an unknown flag rather than ignoring it', () => {
    const parsed = parseReporterArgs(['--broker', 'wss://b', '--secret', RPT, '--spawn'], {})
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('--spawn')
  })

  it('--help exits with usage', () => {
    const parsed = parseReporterArgs(['--help'], {})
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('node-stats-reporter')
  })

  it('carries --disk and --verbose', () => {
    const parsed = parseReporterArgs(['--broker', 'wss://b', '--secret', RPT, '--disk', '/volume1', '--verbose'], {})
    expect(parsed.config?.diskMount).toBe('/volume1')
    expect(parsed.config?.verbose).toBe(true)
  })
})

describe('reconnect backoff', () => {
  it('starts quick and caps, so a refused key does not spin', () => {
    expect(backoffMs(0)).toBe(1000)
    expect(backoffMs(3)).toBe(8000)
    expect(backoffMs(99)).toBe(30_000)
  })

  it('is monotonic up to the cap', () => {
    const values = [0, 1, 2, 3, 4, 5, 6].map(backoffMs)
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
  })
})
