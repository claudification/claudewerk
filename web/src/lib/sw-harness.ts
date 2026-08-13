/**
 * sw-harness - load `web/public/sw.js` into a fake ServiceWorkerGlobalScope so
 * it can be unit-tested.
 *
 * sw.js is a raw, non-module script that only exists inside a real service
 * worker. To test it we evaluate the source with injected globals and keep a
 * handle on the listeners it registers, so a test can fire `install`/`activate`
 * and inspect what happened to CacheStorage.
 *
 * The important trick: `loadServiceWorker()` evaluates the source FRESH each
 * call. Calling it twice models the browser TERMINATING and RESTARTING the
 * worker between events -- which resets every module-level variable, exactly
 * like production. Bugs that depend on state surviving in a module global only
 * show up when you do this.
 */

export interface FakeCache {
  put(request: RequestLike, response: unknown): Promise<void>
  match(request: RequestLike): Promise<unknown | undefined>
  keys(): Promise<string[]>
  delete(request: RequestLike): Promise<boolean>
}

type RequestLike = string | { url: string }

function urlOf(request: RequestLike): string {
  return typeof request === 'string' ? request : request.url
}

/** In-memory CacheStorage that records how many lookups each cache served. */
export class FakeCacheStorage {
  readonly buckets = new Map<string, Map<string, unknown>>()
  /** Per-cache `match` call count -- proves whether lookups walk every generation. */
  readonly matchCalls = new Map<string, number>()

  private bucket(name: string): Map<string, unknown> {
    let b = this.buckets.get(name)
    if (!b) {
      b = new Map()
      this.buckets.set(name, b)
    }
    return b
  }

  async open(name: string): Promise<FakeCache> {
    const b = this.bucket(name)
    return {
      put: async (request, response) => {
        b.set(urlOf(request), response)
      },
      match: async request => {
        this.matchCalls.set(name, (this.matchCalls.get(name) ?? 0) + 1)
        return b.get(urlOf(request))
      },
      keys: async () => [...b.keys()],
      delete: async request => b.delete(urlOf(request)),
    }
  }

  async keys(): Promise<string[]> {
    return [...this.buckets.keys()]
  }

  // Called by the worker's `activate` handler through the injected global, so
  // static analysis cannot see the reference.
  // fallow-ignore-next-line unused-class-member
  async delete(name: string): Promise<boolean> {
    return this.buckets.delete(name)
  }

  /**
   * Global CacheStorage.match -- walks every bucket in insertion order.
   *
   * Modelled faithfully even though the worker no longer calls it, because the
   * cost of that walk is the whole reason the worker stopped: see the
   * "reintroducing the global lookup" test.
   */
  async match(request: RequestLike): Promise<unknown | undefined> {
    for (const name of this.buckets.keys()) {
      const cache = await this.open(name)
      const hit = await cache.match(request)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  /** Total `match` calls across every bucket. */
  totalMatchCalls(): number {
    let total = 0
    for (const n of this.matchCalls.values()) total += n
    return total
  }
}

export interface LoadedWorker {
  /** Fire a registered listener and await whatever it passed to waitUntil/respondWith. */
  dispatch(type: string, event?: Record<string, unknown>): Promise<unknown>
  /** True when the script registered a listener for `type`. */
  has(type: string): boolean
}

export interface LoadOptions {
  caches: FakeCacheStorage
  /** Stand-in for the build-time `__BUILD_HASH__` stamp. */
  buildHash: string
  /** Network. Defaults to a 200 with an empty body for every request. */
  fetch?: (request: RequestLike, init?: unknown) => Promise<unknown>
  /** Body served for `/asset-manifest.json`. */
  manifest?: { buildHash: string; files: Array<{ url: string }> }
}

function defaultResponse(url: string, manifestBody: unknown) {
  const isManifest = url.includes('asset-manifest.json')
  return {
    ok: true,
    url,
    clone() {
      return defaultResponse(url, manifestBody)
    },
    async json() {
      if (!isManifest) throw new Error(`no json body for ${url}`)
      return manifestBody
    },
    headers: { get: () => null },
  }
}

/**
 * Evaluate sw.js against fake globals. Every call is a fresh evaluation, so
 * module-level state does NOT carry across calls (see the note at the top).
 */
export function loadServiceWorker(source: string, opts: LoadOptions): LoadedWorker {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const manifestBody = opts.manifest ?? { buildHash: opts.buildHash, files: [] }
  // `fetch` is called with a URL string during precache and with the event's
  // Request object in the runtime handler -- accept both.
  const doFetch = opts.fetch ?? (async (request: RequestLike) => defaultResponse(urlOf(request), manifestBody))

  const self = {
    addEventListener(type: string, fn: (event: Record<string, unknown>) => void) {
      listeners.set(type, fn)
    },
    skipWaiting() {},
    registration: { showNotification: async () => {} },
    location: { origin: 'https://test.local' },
  }

  const clients = {
    claim: async () => {},
    matchAll: async () => [],
    openWindow: async () => {},
  }

  const stamped = source.replaceAll('__BUILD_HASH__', opts.buildHash)
  // Evaluating the real sw.js source IS the test -- a re-implementation here
  // would not catch the module-state bugs this file exists to guard against.
  const factory = new Function('self', 'caches', 'clients', 'fetch', 'console', stamped)
  factory(self, opts.caches, clients, doFetch, { log() {}, warn() {}, error() {} })

  return {
    has: type => listeners.has(type),
    async dispatch(type, event = {}) {
      const listener = listeners.get(type)
      if (!listener) throw new Error(`sw.js registered no '${type}' listener`)
      let pending: unknown
      listener({ ...event, waitUntil: (p: unknown) => (pending = p), respondWith: (p: unknown) => (pending = p) })
      return await pending
    },
  }
}
