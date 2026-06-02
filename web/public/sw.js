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

// @build __BUILD_HASH__
const PRECACHE = 'rclaude-precache'
const FILE_CACHE = 'rclaude-files-v1'
const FILE_CACHE_MAX = 50
const FILE_CACHE_MAX_SIZE = 2 * 1024 * 1024

let installedBuildHash = null

// ─── Install: precache from manifest ─────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    fetch('/asset-manifest.json')
      .then(res => res.json())
      .then(async manifest => {
        installedBuildHash = manifest.buildHash
        const cache = await caches.open(`${PRECACHE}-${manifest.buildHash}`)

        // Carry unchanged assets forward instead of re-downloading them.
        // Asset URLs are content-hashed: an identical URL means identical
        // bytes, so any URL already sitting in a prior precache is safe to
        // reuse verbatim. Without this, every deploy re-fetched the WHOLE
        // asset set over the network (CodeMirror, shiki, mermaid, xterm,
        // react -- ~1MB) even though only the app chunk's hash actually
        // changed. Now only genuinely new/changed chunks hit the network.
        const keys = await caches.keys()
        const oldCaches = await Promise.all(
          keys.filter(k => k.startsWith(PRECACHE) && k !== `${PRECACHE}-${manifest.buildHash}`).map(k => caches.open(k)),
        )

        const urls = manifest.files.filter(f => !f.url.endsWith('.map')).map(f => f.url)
        urls.push('/')

        let reused = 0
        let fetched = 0
        await Promise.all(
          urls.map(async url => {
            // '/' is the HTML shell -- it references the new hashed chunk
            // names, so it changes every deploy. Never reuse it.
            if (url !== '/') {
              for (const old of oldCaches) {
                const hit = await old.match(url)
                if (hit) {
                  await cache.put(url, hit.clone())
                  reused++
                  return
                }
              }
            }
            // New or changed (or the HTML shell): fetch from network. Failures
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
      const keys = await caches.keys()
      const allPrecaches = keys.filter(k => k.startsWith(PRECACHE))
      const currentName = installedBuildHash ? `${PRECACHE}-${installedBuildHash}` : null
      const oldPrecaches = currentName ? allPrecaches.filter(k => k !== currentName) : []
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
          client.postMessage({ type: 'sw-updated', from: fromHash, to: installedBuildHash })
        }
      }
    })(),
  )
})

// ─── Fetch: precache-first, with runtime caching for /file/* ─────

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

  if (url.pathname.startsWith('/assets/') || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(`${PRECACHE}-runtime`).then(cache => cache.put(event.request, clone))
          }
          return response
        })
      }),
    )
    return
  }

  if (url.pathname.match(/\.(png|ico|svg|woff2?|webmanifest)$/)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(`${PRECACHE}-runtime`).then(cache => cache.put(event.request, clone))
          }
          return response
        })
      }),
    )
    return
  }

  if (url.pathname.startsWith('/file/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached
        return fetch(event.request).then(response => {
          if (!response.ok) return response
          const size = response.headers.get('content-length')
          if (size && parseInt(size, 10) > FILE_CACHE_MAX_SIZE) return response
          const clone = response.clone()
          caches.open(FILE_CACHE).then(async cache => {
            await cache.put(event.request, clone)
            const keys = await cache.keys()
            if (keys.length > FILE_CACHE_MAX) {
              const toDelete = keys.slice(0, keys.length - FILE_CACHE_MAX)
              await Promise.all(toDelete.map(key => cache.delete(key)))
            }
          })
          return response
        })
      }),
    )
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
