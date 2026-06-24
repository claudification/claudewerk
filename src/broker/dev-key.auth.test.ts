import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getHmacSecret, initAuth, validateConversation } from './auth'
import { devHarnessSecret, mintDevKey } from './dev-key'

// Integration test: prove a dev key flows through the REAL broker session
// validator (validateConversation) and authenticates as the impersonated user
// when the flag is on, and is rejected when off.

let cacheDir = ''
const savedFlag = process.env.DEV_HARNESS_ENABLED
const savedSecret = process.env.DEV_HARNESS_SIGNING_SECRET

beforeAll(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'dev-key-auth-'))
  delete process.env.DEV_HARNESS_SIGNING_SECRET // exercise the session-secret fallback
  initAuth({ cacheDir, skipTimers: true })
})

afterAll(() => {
  if (savedFlag === undefined) delete process.env.DEV_HARNESS_ENABLED
  else process.env.DEV_HARNESS_ENABLED = savedFlag
  if (savedSecret === undefined) delete process.env.DEV_HARNESS_SIGNING_SECRET
  else process.env.DEV_HARNESS_SIGNING_SECRET = savedSecret
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true })
})

function mint(user: string, ttlSec = 3600): string {
  return mintDevKey({ user, ttlSec, secret: devHarnessSecret(getHmacSecret()) })
}

describe('validateConversation -- dev key wiring', () => {
  it('authenticates AS the impersonated user when DEV_HARNESS_ENABLED=1', () => {
    process.env.DEV_HARNESS_ENABLED = '1'
    expect(validateConversation(mint('jonas'))).toEqual({ name: 'jonas' })
    expect(validateConversation(mint('lisa'))).toEqual({ name: 'lisa' })
  })

  it('rejects the same valid token when the flag is OFF (prod safety)', () => {
    process.env.DEV_HARNESS_ENABLED = '1'
    const token = mint('jonas')
    delete process.env.DEV_HARNESS_ENABLED
    expect(validateConversation(token)).toBeNull()
  })

  it('rejects an expired dev token even with the flag on', () => {
    process.env.DEV_HARNESS_ENABLED = '1'
    const expired = mintDevKey({ user: 'jonas', ttlSec: 1, secret: devHarnessSecret(getHmacSecret()), now: 1_000 })
    expect(validateConversation(expired)).toBeNull()
  })

  it('does not disturb the normal session-token path (garbage still rejected)', () => {
    process.env.DEV_HARNESS_ENABLED = '1'
    expect(validateConversation('garbage.sig')).toBeNull()
  })
})
