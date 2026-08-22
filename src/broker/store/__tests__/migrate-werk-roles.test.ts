/**
 * SCHEMA v8 -- the werk-* seat rename, on the rows that carry the old word.
 *
 * `EpicLaunchTag.role` is persisted on every conversation the epic engine has
 * ever dispatched, and liveness, the concurrency ceiling and the reserved-lane
 * rule all fold over it. This file is the receipt for the three properties the
 * rename actually depends on: the old spellings move, nothing ELSE in the meta
 * blob moves with them, and the pass is idempotent.
 *
 * NO TEST ASSERTS A READ ALIAS, and that absence is deliberate: the migration
 * is the only thing in the tree that knows the old words, and a test pinning an
 * alias in `conversation-role.ts` would be pinning the permanent alias this
 * rename decided against.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStartupMigration, SCHEMA_VERSION } from '../migrate'
import { createSqliteDriver } from '../sqlite/driver'
import type { StoreDriver } from '../types'

let cacheDir = ''
let store: StoreDriver

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'migrate-werk-roles-'))
  store = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
  store.init()
  // Stamp v7 so the run is exactly the v7 -> v8 step and no earlier migration
  // is competing for the same rows.
  store.kv.set('schema-version', 7)
})

afterEach(() => {
  store.close?.()
  rmSync(cacheDir, { recursive: true, force: true })
})

function seed(id: string, meta: Record<string, unknown>): void {
  store.conversations.create({
    id,
    scope: 'claude://default/Users/x/proj',
    agentType: 'claude',
    createdAt: 1,
    meta,
  })
}

function epicTag(id: string, role: string, extra: Record<string, unknown> = {}): void {
  seed(id, { launchConfig: { epic: { epicId: 'e1', role, gen: 3, ...extra } } })
}

function roleOf(id: string): unknown {
  const meta = (store.conversations.get(id)?.meta || {}) as { launchConfig?: { epic?: { role?: unknown } } }
  return meta.launchConfig?.epic?.role
}

describe('v8 rewrites the stored seat role', () => {
  test('every old spelling becomes its werk-* name', () => {
    epicTag('c_ov', 'overseer')
    epicTag('c_im', 'implementer')
    epicTag('c_ve', 'verifier')

    const out = runStartupMigration(store, cacheDir)

    expect(out.toVersion).toBe(SCHEMA_VERSION)
    expect(roleOf('c_ov')).toBe('werk-master')
    expect(roleOf('c_im')).toBe('werk-worker')
    expect(roleOf('c_ve')).toBe('werk-verifier')
  })

  /** The count query the card asked for, before AND after -- `remaining` is the
   *  after, and it is reported rather than inferred from the absence of noise. */
  test('the result carries the before count, what moved, and what is left', () => {
    epicTag('c_ov', 'overseer')
    epicTag('c_ov2', 'overseer')
    epicTag('c_im', 'implementer')
    epicTag('c_new', 'werk-verifier')
    seed('c_plain', { launchConfig: {} })

    const r = runStartupMigration(store, cacheDir).epicRolesRenamed

    expect(r?.tagged).toBe(4)
    expect(r?.rewritten).toEqual({ overseer: 2, implementer: 1 })
    expect(r?.remaining).toBe(0)
  })

  test('a row already on the new vocabulary is left exactly as it is', () => {
    epicTag('c_new', 'werk-master')
    runStartupMigration(store, cacheDir)
    expect(roleOf('c_new')).toBe('werk-master')
  })

  test('a conversation with no epic tag is not counted and not touched', () => {
    seed('c_plain', { launchConfig: { nightshift: { runId: 'r', taskId: 't' } } })
    const r = runStartupMigration(store, cacheDir).epicRolesRenamed
    expect(r?.tagged).toBe(0)
    const meta = store.conversations.get('c_plain')?.meta as { launchConfig?: { nightshift?: unknown } }
    expect(meta.launchConfig?.nightshift).toEqual({ runId: 'r', taskId: 't' })
  })

  /**
   * THE REASON THIS IS A JS PASS AND NOT A SQL `REPLACE` OVER THE BLOB. The word
   * "overseer" appears in prompts, titles and result text of conversations that
   * have nothing to do with a seat. A text substitution would rewrite those too.
   */
  test('the word survives everywhere it is not the role', () => {
    seed('c_prose', {
      launchConfig: { epic: { epicId: 'e1', role: 'overseer', gen: 1 } },
      resultText: 'asked the overseer about the implementer',
      title: 'overseer notes',
    })

    runStartupMigration(store, cacheDir)

    const meta = store.conversations.get('c_prose')?.meta as { resultText?: string; title?: string }
    expect(roleOf('c_prose')).toBe('werk-master')
    expect(meta.resultText).toBe('asked the overseer about the implementer')
    expect(meta.title).toBe('overseer notes')
  })

  test('the rest of the launch tag rides through untouched', () => {
    epicTag('c_ov', 'overseer', { cardId: 't7' })
    runStartupMigration(store, cacheDir)
    const meta = store.conversations.get('c_ov')?.meta as {
      launchConfig?: { epic?: Record<string, unknown> }
    }
    expect(meta.launchConfig?.epic).toEqual({ epicId: 'e1', role: 'werk-master', gen: 3, cardId: 't7' })
  })

  test('re-running is a no-op -- the stamp short-circuits and the rows stay put', () => {
    epicTag('c_ov', 'overseer')
    runStartupMigration(store, cacheDir)
    const second = runStartupMigration(store, cacheDir)
    expect(second.skipped).toBe(true)
    expect(second.epicRolesRenamed).toBeUndefined()
    expect(roleOf('c_ov')).toBe('werk-master')
  })
})
