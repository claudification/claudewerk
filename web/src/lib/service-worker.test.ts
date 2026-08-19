/**
 * @vitest-environment node
 */
/**
 * Regression tests for the two service-worker defects behind "reloading the
 * panel is incredibly slow, even on LAN".
 *
 * DEFECT 1 -- old cache generations are never deleted.
 *   `activate` decided what to delete from `installedBuildHash`, a module-level
 *   variable assigned in the `install` handler. The browser is free to TERMINATE
 *   a service worker between events, and it routinely does: the next event runs
 *   in a fresh script evaluation where that variable is back to `null`. The
 *   handler then computed `oldPrecaches = []` and deleted nothing, so every
 *   deploy left its whole precache generation behind forever.
 *
 * DEFECT 2 -- every asset lookup walked every generation.
 *   The fetch handler called the GLOBAL `caches.match(request)`, which iterates
 *   all caches in CacheStorage until something hits. Combined with defect 1 that
 *   is O(generations) per asset, on the single-threaded worker that serializes
 *   EVERY fetch event -- including the `/api/*` requests the handler only passes
 *   through. That is why a local HMAC token mint measured 3.7s in production
 *   logs and finished in the same millisecond as a batch of stalled chunks.
 *
 * Both are load-bearing for cold-load latency, so both get a test that fails
 * against the old implementation.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { FakeCacheStorage, loadServiceWorker } from './sw-harness'

const SW_PATH = join(__dirname, '../../public/sw.js')
const OLD_HASH = 'aaaaaaaaaaaa'
const NEW_HASH = 'bbbbbbbbbbbb'

let source: string

beforeAll(() => {
  source = readFileSync(SW_PATH, 'utf8')
})

function manifestFor(hash: string, urls: string[]) {
  return { buildHash: hash, files: urls.map(url => ({ url })) }
}

describe('service worker cache generations', () => {
  test('activate deletes stale generations even after the worker restarted', async () => {
    const caches = new FakeCacheStorage()

    // A previous deploy left its generation behind.
    const stale = await caches.open(`rclaude-precache-${OLD_HASH}`)
    await stale.put('/assets/old-chunk.js', { ok: true })

    // Instance 1 installs the new build.
    const installing = loadServiceWorker(source, {
      caches,
      buildHash: NEW_HASH,
      manifest: manifestFor(NEW_HASH, ['/assets/new-chunk.js']),
    })
    await installing.dispatch('install')

    // The browser terminates the worker, then fires `activate` on a FRESH
    // evaluation -- every module-level variable is back to its initial value.
    const activating = loadServiceWorker(source, {
      caches,
      buildHash: NEW_HASH,
      manifest: manifestFor(NEW_HASH, ['/assets/new-chunk.js']),
    })
    await activating.dispatch('activate')

    const remaining = (await caches.keys()).filter(k => k.startsWith('rclaude-precache'))
    expect(remaining).toEqual([`rclaude-precache-${NEW_HASH}`])
  })

  test('an asset served from the current generation does not touch stale ones', async () => {
    const caches = new FakeCacheStorage()

    // Four deploys' worth of leaked generations.
    for (let i = 0; i < 4; i++) {
      const old = await caches.open(`rclaude-precache-stale${i}`)
      await old.put('/assets/unrelated.js', { ok: true })
    }

    const worker = loadServiceWorker(source, {
      caches,
      buildHash: NEW_HASH,
      manifest: manifestFor(NEW_HASH, ['/assets/app.js']),
    })
    await worker.dispatch('install')
    caches.matchCalls.clear()

    const hit = await worker.dispatch('fetch', {
      request: { method: 'GET', url: 'https://test.local/assets/app.js' },
    })

    expect(hit).toBeDefined()
    const staleLookups = [...caches.matchCalls.entries()].filter(([name]) => name.includes('stale'))
    expect(staleLookups).toEqual([])
  })

  test('the global lookup the worker no longer uses costs one probe per generation', async () => {
    // Guards the reasoning behind precacheFirst(): this is what `caches.match`
    // charges you, and it is charged on the worker's single thread, in front of
    // every other queued fetch event.
    const caches = new FakeCacheStorage()
    for (let i = 0; i < 6; i++) {
      const gen = await caches.open(`rclaude-precache-gen${i}`)
      await gen.put('/assets/only-in-the-last-one.js', i === 5 ? { ok: true } : undefined)
    }
    caches.matchCalls.clear()

    await caches.match('/assets/only-in-the-last-one.js')

    expect(caches.totalMatchCalls()).toBe(6)
  })

  test('a pass-through request is not handled by the worker at all', async () => {
    const caches = new FakeCacheStorage()
    const worker = loadServiceWorker(source, {
      caches,
      buildHash: NEW_HASH,
      manifest: manifestFor(NEW_HASH, []),
    })

    let responded = false
    const listenerResult = await worker
      .dispatch('fetch', {
        request: { method: 'POST', url: 'https://test.local/api/voice/stt-token' },
        respondWith: () => {
          responded = true
        },
      })
      .catch(() => undefined)

    expect(responded).toBe(false)
    expect(listenerResult).toBeUndefined()
  })
})
