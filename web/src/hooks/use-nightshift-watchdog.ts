/**
 * useNightshiftWatchdog -- the live decision log for one project's nightshift
 * watchdog (plan-nightshift.md §2.5 Status screen).
 *
 * Wire:
 *   nightshift_watchdog_request { project, requestId, limit }
 *     -> nightshift_watchdog_result { ok, decisions }     (backfill on mount)
 *   nightshift_watchdog_event { project, decision }        (live beat -> prepend)
 *
 * Handler slot: store.nightshiftWatchdogHandler (routed by use-websocket.ts).
 * Mirrors use-nightshift.ts (per-project cache + useSyncExternalStore), but the
 * live feed APPENDS decisions rather than re-fetching a snapshot.
 */

import type { WatchdogDecision } from '@shared/protocol'
import { useEffect, useSyncExternalStore } from 'react'
import { useConversationsStore } from './use-conversations'

const REQUEST_TIMEOUT_MS = 12_000
const MAX_KEEP = 500 // cap client-side retention; matches the broker ring's spirit

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}
const pendingRequests = new Map<string, PendingRequest>()

interface WatchdogCache {
  projectUri: string
  decisions: WatchdogDecision[] // newest-first
  loaded: boolean
  loading: boolean
  error: string | null
  inflight: Promise<void> | null
  seen: Set<string> // decision ids, for dedup across backfill + live beats
  subscribers: Set<() => void>
}

const caches = new Map<string, WatchdogCache>()
const cacheVersions = new WeakMap<WatchdogCache, number>()
let handlerInstalled = false

function ensureCache(projectUri: string): WatchdogCache {
  let c = caches.get(projectUri)
  if (!c) {
    c = {
      projectUri,
      decisions: [],
      loaded: false,
      loading: false,
      error: null,
      inflight: null,
      seen: new Set(),
      subscribers: new Set(),
    }
    caches.set(projectUri, c)
  }
  return c
}

function notify(c: WatchdogCache): void {
  cacheVersions.set(c, (cacheVersions.get(c) ?? 0) + 1)
  for (const sub of c.subscribers) sub()
}

/** Insert newest-first, dedup by id, cap length. Returns true if anything changed. */
function ingest(c: WatchdogCache, incoming: WatchdogDecision[]): boolean {
  let changed = false
  for (const d of incoming) {
    if (!d || c.seen.has(d.id)) continue
    c.seen.add(d.id)
    c.decisions.push(d)
    changed = true
  }
  if (!changed) return false
  c.decisions.sort((a, b) => b.at - a.at)
  if (c.decisions.length > MAX_KEEP) {
    for (const d of c.decisions.splice(MAX_KEEP)) c.seen.delete(d.id)
  }
  return true
}

function sendWire(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error('watchdog request timed out'))
    }, REQUEST_TIMEOUT_MS)
    pendingRequests.set(requestId, { resolve, reject, timeout })
    useConversationsStore.getState().sendWsMessage({ ...payload, requestId })
  })
}

async function backfill(c: WatchdogCache): Promise<void> {
  if (c.inflight) return c.inflight
  const promise = (async () => {
    c.loading = true
    c.error = null
    notify(c)
    try {
      const resp = await sendWire({ type: 'nightshift_watchdog_request', project: c.projectUri, limit: MAX_KEEP })
      if (resp.ok === false) c.error = (resp.error as string) ?? 'unknown error'
      else ingest(c, (resp.decisions as WatchdogDecision[] | undefined) ?? [])
      c.loaded = true
    } catch (err) {
      c.error = err instanceof Error ? err.message : String(err)
    } finally {
      c.loading = false
      c.inflight = null
      notify(c)
    }
  })()
  c.inflight = promise
  return promise
}

function installHandler(): void {
  if (handlerInstalled) return
  handlerInstalled = true
  useConversationsStore.setState({
    nightshiftWatchdogHandler: (msg: Record<string, unknown>) => {
      if (msg.type === 'nightshift_watchdog_result') {
        const requestId = msg.requestId as string | undefined
        if (!requestId) return
        const pending = pendingRequests.get(requestId)
        if (!pending) return
        clearTimeout(pending.timeout)
        pendingRequests.delete(requestId)
        if (msg.ok === false && msg.error) pending.reject(new Error(msg.error as string))
        else pending.resolve(msg)
        return
      }
      if (msg.type === 'nightshift_watchdog_event') {
        const projectUri = msg.project as string | undefined
        const decision = msg.decision as WatchdogDecision | undefined
        if (!projectUri || !decision) return
        const c = caches.get(projectUri)
        if (!c) return
        if (ingest(c, [decision])) notify(c)
      }
    },
  })
}

export interface WatchdogState {
  decisions: WatchdogDecision[]
  loading: boolean
  error: string | null
  refetch: () => void
}

const EMPTY: WatchdogState = { decisions: [], loading: false, error: null, refetch: () => {} }
const stable = new WeakMap<WatchdogCache, { version: number; state: WatchdogState }>()

function buildState(c: WatchdogCache): WatchdogState {
  const version = cacheVersions.get(c) ?? 0
  const cached = stable.get(c)
  if (cached && cached.version === version) return cached.state
  const state: WatchdogState = {
    decisions: c.decisions,
    loading: c.loading,
    error: c.error,
    refetch: () => {
      c.inflight = null
      void backfill(c)
    },
  }
  stable.set(c, { version, state })
  return state
}

export function useNightshiftWatchdog(projectUri: string | null): WatchdogState {
  useEffect(() => {
    installHandler()
  }, [])

  const state = useSyncExternalStore<WatchdogState>(
    onChange => {
      if (!projectUri) return () => {}
      const c = ensureCache(projectUri)
      c.subscribers.add(onChange)
      return () => c.subscribers.delete(onChange)
    },
    () => (projectUri ? buildState(ensureCache(projectUri)) : EMPTY),
    () => EMPTY,
  )

  useEffect(() => {
    if (!projectUri) return
    const c = ensureCache(projectUri)
    if (!c.loaded && !c.inflight) void backfill(c)
  }, [projectUri])

  return state
}
