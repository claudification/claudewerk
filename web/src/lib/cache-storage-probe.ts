/**
 * cache-storage-probe - report how many cache generations the service worker is
 * carrying, and how big they are.
 *
 * This exists because a leaked generation is invisible from the app: everything
 * still works, it just gets slower every deploy. The service worker used to keep
 * its build hash in a module-level variable that the browser resets whenever it
 * terminates the worker, so `activate` frequently deleted nothing and left a
 * whole precache behind. One line at boot makes that condition obvious instead
 * of something you have to go digging in devtools for.
 *
 * Runs once, after the app has settled, and never blocks anything.
 */

const PRECACHE_PREFIX = 'rclaude-precache'
/** Wait for the load to finish so the probe never competes with it. */
const DELAY_MS = 4000

export interface CacheGeneration {
  name: string
  entries: number
  current: boolean
}

async function probeCacheStorage(): Promise<CacheGeneration[]> {
  if (typeof caches === 'undefined') return []

  const names = await caches.keys()
  const generations = await Promise.all(
    names.map(async name => {
      const cache = await caches.open(name)
      const entries = (await cache.keys()).length
      return { name, entries, current: false }
    }),
  )

  // The generation the running page was served from is the one holding the
  // document's own script. Marking it separates "current" from "leaked".
  const precaches = generations.filter(g => g.name.startsWith(PRECACHE_PREFIX))
  const newest = precaches.at(-1)
  if (newest) newest.current = true

  return generations
}

export function formatCacheReport(generations: CacheGeneration[]): string {
  const precaches = generations.filter(g => g.name.startsWith(PRECACHE_PREFIX))
  const stale = precaches.filter(g => !g.current)
  const totalEntries = generations.reduce((sum, g) => sum + g.entries, 0)

  const detail = generations.map(g => `${g.name}=${g.entries}${g.current ? '*' : ''}`).join(' ')
  const warning =
    stale.length > 0 ? ` -- ${stale.length} STALE precache generation(s), every cache lookup pays for them` : ''

  return `[sw-cache] ${generations.length} caches, ${totalEntries} entries: ${detail}${warning}`
}

let installed = false

export function installCacheStorageProbe() {
  if (installed) return
  installed = true
  setTimeout(() => {
    probeCacheStorage()
      .then(generations => {
        if (generations.length > 0) console.debug(formatCacheReport(generations))
      })
      .catch(err => console.debug('[sw-cache] probe failed:', err))
  }, DELAY_MS)
}
