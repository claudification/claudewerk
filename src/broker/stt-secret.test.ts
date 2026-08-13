/**
 * A broker that invents a signing secret the Worker does not share rejects every
 * dictation with a 401 and no other clue, so the get-or-create behaviour and the
 * "never in global settings" boundary both get tests.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { KVStore } from './store/types'
import { getSttSigningSecret, resetSttSigningSecretCache } from './stt-secret'

function fakeKv(initial: Record<string, unknown> = {}): KVStore & { data: Record<string, unknown> } {
  const data = { ...initial }
  return {
    data,
    get: <T>(key: string) => data[key] as T,
    set: (key: string, value: unknown) => {
      data[key] = value
    },
    delete: (key: string) => {
      delete data[key]
    },
  } as unknown as KVStore & { data: Record<string, unknown> }
}

beforeEach(() => {
  resetSttSigningSecretCache()
  delete process.env.STT_SIGNING_SECRET
})

describe('getSttSigningSecret', () => {
  it('prefers STT_SIGNING_SECRET from the env, so an operator can pin it', () => {
    // `wrangler secret list` cannot read a value back, so pinning the broker to
    // the Worker's existing secret has to come from somewhere explicit.
    process.env.STT_SIGNING_SECRET = 'pinned-to-the-worker'
    const kv = fakeKv({ 'stt-signing-secret': 'the-kv-one' })
    expect(getSttSigningSecret(kv)).toBe('pinned-to-the-worker')
    // ...and it must NOT overwrite what is in KV.
    expect(kv.data['stt-signing-secret']).toBe('the-kv-one')
  })

  it('returns the stored secret unchanged', () => {
    const kv = fakeKv({ 'stt-signing-secret': 'the-existing-one' })
    expect(getSttSigningSecret(kv)).toBe('the-existing-one')
  })

  it('generates and PERSISTS one when absent, so it survives a restart', () => {
    const kv = fakeKv()
    const created = getSttSigningSecret(kv)
    expect(created.length).toBeGreaterThan(32)
    // Persisted: a secret regenerated on every boot would silently invalidate
    // every token the Worker was told to trust.
    expect(kv.data['stt-signing-secret']).toBe(created)
  })

  it('is stable across calls within a process', () => {
    const kv = fakeKv()
    expect(getSttSigningSecret(kv)).toBe(getSttSigningSecret(kv))
  })

  it('lives under its OWN key, never inside global-settings', () => {
    // global-settings is serialised to the frontend; a signing key in there
    // would be handed to every browser that opens the control panel.
    const kv = fakeKv()
    getSttSigningSecret(kv)
    expect(Object.keys(kv.data)).toEqual(['stt-signing-secret'])
    expect(kv.data['global-settings']).toBeUndefined()
  })

  it('does not reuse a secret across brokers with different stores', () => {
    const a = getSttSigningSecret(fakeKv())
    resetSttSigningSecretCache()
    const b = getSttSigningSecret(fakeKv())
    expect(a).not.toBe(b)
  })
})
