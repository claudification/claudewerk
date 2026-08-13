/**
 * Service Worker - Manifest-based precaching + push notifications
 *
 * On install: fetches /asset-manifest.json, precaches all listed files.
 * On update: if manifest changed, new SW installs with new cache.
 * Runtime: cache-first for precached assets, network-first for API/dynamic.
 * /file/* blobs: LRU cache (max 50, skip >2MB).
 *
 * BUILD_HASH is stamped by the Vite build plugin so the browser detects
 * sw.js as "changed" on each build, triggering reinstall + precache.
 */

// Stamped by the Vite build plugin from the same hash that goes into
// asset-manifest.json. This is a CONSTANT on purpose: a service worker is
// terminated and restarted between events at the browser's discretion, so the
// worker's own identity must never live in mutable module state (see the
// `installedBuildHash` regression in service-worker.test.ts).
const BUILD_HASH = '__BUILD_HASH__'
const PRECACHE = 'rclaude-precache'
const CURRENT_PRECACHE = `${PRECACHE}-${BUILD_HASH}`
const FILE_CACHE = 'rclaude-files-v1'
const FILE_CACHE_MAX = 50
const FILE_CACHE_MAX_SIZE = 2 * 1024 * 1024

/** Root-relative path for a cache key, which may be a Request or a string. */
function pathOf(request) {
  const raw = typeof request === 'string' ? request : request.url
  if (!raw) return null
  try {
    return new URL(raw, self.location.origin).pathname
  } catch {
    return raw
  }
}

// ─── Install: precache from manifest ─────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    fetch('/asset-manifest.json')
      .then(res => res.json())
      .then(async manifest => {
        const cache = await caches.open(CURRENT_PRECACHE)

        // Carry unchanged assets forward instead of re-downloading them.
        // Asset URLs are content-hashed: an identical URL means identical
        // bytes, so any URL already sitting in a prior precache is safe to
        // reuse verbatim. Without this, every deploy re-fetched the WHOLE
        // asset set over the network (CodeMirror, shiki, mermaid, xterm,
        // react -- ~1MB) even though only the app chunk's hash actually
        // changed. Now only genuinely new/changed chunks hit the network.
        //
        // Index the old generations by URL up front. The previous version ran
        // `old.match(url)` against every generation for every one of the ~400
        // manifest URLs, sequentially, on the worker's single thread -- which
        // is what made a deploy's first load stall for seconds.
        const keys = await caches.keys()
        const oldNames = keys.filter(k => k.startsWith(PRECACHE) && k !== CURRENT_PRECACHE)
        // Keyed by PATHNAME: `cache.keys()` yields absolute request URLs while
        // the manifest lists root-relative ones, so the two only line up once
        // both sides are reduced to a path.
        const sourceFor = new Map()
        await Promise.all(
          oldNames.map(async name => {
            const old = await caches.open(name)
            for (const req of await old.keys()) {
              const path = pathOf(req)
              if (path && !sourceFor.has(path)) sourceFor.set(path, old)
            }
          }),
        )

        const urls = manifest.files.filter(f => !f.url.endsWith('.map')).map(f => f.url)
        urls.push('/')

        let reused = 0
        let fetched = 0
        await Promise.all(
          urls.map(async url => {
            // Only /assets/* are content-hashed (identical URL == identical
            // bytes), so only those are safe to reuse by URL. The HTML shell
            // ('/') and stable-named files (sw.js, icons, favicon) keep the
            // same URL while their content changes every deploy -- always
            // re-fetch those.
            if (url.startsWith('/assets/')) {
              const old = sourceFor.get(url)
              const hit = old ? await old.match(url) : null
              if (hit) {
                await cache.put(url, hit.clone())
                reused++
                return
              }
            }
            // New or changed (or a stable-named file): fetch from network. Failures
            // are tolerated -- the runtime fetch handler falls back to network,
            // and a partial precache still beats failing the whole install.
            try {
              const res = await fetch(url, { cache: 'no-cache' })
              if (res.ok) {
                await cache.put(url, res.clone())
                fetched++
              }
            } catch (e) {
              console.warn(`[sw] precache fetch failed: ${url}`, e)
            }
          }),
        )
        console.log(
          `[sw] precached ${urls.length} files (build: ${manifest.buildHash}) -- reused ${reused}, fetched ${fetched}`,
        )
      })
      .catch(err => console.warn('[sw] precache failed:', err)),
  )
  self.skipWaiting()
})

// ─── Activate: clean old precaches, claim clients, signal real updates ──

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // BUILD_HASH is a constant, so this is correct even when the browser
      // terminated the worker after `install` and ran `activate` in a fresh
      // script evaluation. The old version read a module-level variable here
      // and, on that very common path, deleted nothing at all -- leaving one
      // full precache generation behind per deploy, forever.
      const keys = await caches.keys()
      const oldPrecaches = keys.filter(k => k.startsWith(PRECACHE) && k !== CURRENT_PRECACHE)
      await Promise.all(
        oldPrecaches.map(k => {
          console.log(`[sw] deleting old cache: ${k}`)
          return caches.delete(k)
        }),
      )
      await clients.claim()
      if (oldPrecaches.length > 0) {
        const fromHash = oldPrecaches[0].slice(PRECACHE.length + 1) || null
        const cls = await clients.matchAll({ type: 'window' })
        for (const client of cls) {
          client.postMessage({ type: 'sw-updated', from: fromHash, to: BUILD_HASH })
        }
      }
    })(),
  )
})

// ─── Fetch: precache-first, with runtime caching for /file/* ─────

/**
 * Serve from THIS build's precache, falling back to the network and filling the
 * same generation on a miss.
 *
 * Deliberately `cache.match` on one named cache rather than the global
 * `caches.match(request)`. The global form walks every cache in CacheStorage
 * until something hits -- O(generations) per asset, on the worker's single
 * thread, which serializes every other fetch event queued behind it (including
 * the `/api/*` requests this handler does not even touch).
 */
async function precacheFirst(request) {
  const cache = await caches.open(CURRENT_PRECACHE)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    const clone = response.clone()
    cache.put(request, clone)
  }
  return response
}

/** True when a response is small enough to be worth keeping in the blob cache. */
function fitsInFileCache(response) {
  if (!response.ok) return false
  const size = response.headers.get('content-length')
  return !(size && parseInt(size, 10) > FILE_CACHE_MAX_SIZE)
}

/** Drop the oldest entries once the blob cache grows past its cap. */
async function trimFileCache(cache) {
  const keys = await cache.keys()
  if (keys.length <= FILE_CACHE_MAX) return
  const toDelete = keys.slice(0, keys.length - FILE_CACHE_MAX)
  await Promise.all(toDelete.map(key => cache.delete(key)))
}

/** Blob cache for /file/*, LRU-trimmed, skipping anything over the size cap. */
async function fileCacheFirst(request) {
  const cache = await caches.open(FILE_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (!fitsInFileCache(response)) return response

  cache.put(request, response.clone()).then(() => trimFileCache(cache))
  return response
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/sessions/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/ws')
  )
    return

  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname.match(/\.(png|ico|svg|woff2?|webmanifest)$/)
  ) {
    event.respondWith(precacheFirst(event.request))
    return
  }

  if (url.pathname.startsWith('/file/')) {
    event.respondWith(fileCacheFirst(event.request))
    return
  }
})

// ─── Push Notifications ──────────────────────────────────────────

self.addEventListener('push', event => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    payload = { title: 'rclaude', body: event.data.text() }
  }

  const title = payload.title || 'rclaude'
  const conversationId = payload.conversationId
  const taskId = payload.data?.taskId
  const defaultUrl = taskId ? `/#task/${taskId}` : conversationId ? `/#conversation/${conversationId}` : '/'

  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || `rclaude-${Date.now()}`,
    data: {
      conversationId,
      taskId,
      url: defaultUrl,
      ...payload.data,
    },
    vibrate: [200, 100, 200],
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()

  const url = event.notification.data?.url || '/'
  const conversationId = event.notification.data?.conversationId
  const taskId = event.notification.data?.taskId

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus()
          if (taskId) {
            client.postMessage({ type: 'navigate-task', taskId })
          } else if (conversationId) {
            client.postMessage({ type: 'navigate-conversation', conversationId })
          }
          return
        }
      }
      return clients.openWindow(url)
    }),
  )
})
