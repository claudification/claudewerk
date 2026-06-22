/**
 * useNightshift -- fetch + subscribe to the latest nightshift run snapshot.
 *
 * Wire:
 *   nightshift_request { op:'snapshot', project, requestId }
 *     -> nightshift_result { ok, snapshot }
 *   nightshift_event { project, ... } live broadcast -> re-fetch
 *
 * Handler slot: store.nightshiftHandler (routed by use-websocket.ts)
 */

import type { NightshiftRunSnapshot } from '@shared/nightshift-types'
import { useEffect, useSyncExternalStore } from 'react'
import { useConversationsStore } from './use-conversations'

const REQUEST_TIMEOUT_MS = 12_000

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const pendingRequests = new Map<string, PendingRequest>()

interface NightshiftCache {
  projectUri: string
  snapshot: NightshiftRunSnapshot | null | undefined // undefined = not yet loaded
  loading: boolean
  error: string | null
  inflightFetch: Promise<void> | null
  subscribers: Set<() => void>
}

const caches = new Map<string, NightshiftCache>()
const cacheVersions = new WeakMap<NightshiftCache, number>()
let handlerInstalled = false

function ensureCache(projectUri: string): NightshiftCache {
  let c = caches.get(projectUri)
  if (!c) {
    c = {
      projectUri,
      snapshot: undefined,
      loading: false,
      error: null,
      inflightFetch: null,
      subscribers: new Set(),
    }
    caches.set(projectUri, c)
  }
  return c
}

function notifyCache(c: NightshiftCache): void {
  cacheVersions.set(c, (cacheVersions.get(c) ?? 0) + 1)
  for (const sub of c.subscribers) sub()
}

function sendWire(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error('nightshift request timed out'))
    }, REQUEST_TIMEOUT_MS)
    pendingRequests.set(requestId, { resolve, reject, timeout })
    useConversationsStore.getState().sendWsMessage({ ...payload, requestId })
  })
}

async function fetchSnapshot(c: NightshiftCache): Promise<void> {
  if (c.inflightFetch) return c.inflightFetch
  const promise = (async () => {
    c.loading = true
    c.error = null
    notifyCache(c)
    try {
      const resp = await sendWire({ type: 'nightshift_request', project: c.projectUri, op: 'snapshot' })
      c.snapshot = (resp.snapshot as NightshiftRunSnapshot | null | undefined) ?? null
      c.error = resp.ok === false ? ((resp.error as string) ?? 'unknown error') : null
    } catch (err) {
      c.error = err instanceof Error ? err.message : String(err)
    } finally {
      c.loading = false
      c.inflightFetch = null
      notifyCache(c)
    }
  })()
  c.inflightFetch = promise
  return promise
}

function installHandler(): void {
  if (handlerInstalled) return
  handlerInstalled = true
  useConversationsStore.setState({
    nightshiftHandler: (msg: Record<string, unknown>) => {
      // Request/response reply
      if (msg.type === 'nightshift_result') {
        const requestId = msg.requestId as string | undefined
        if (requestId) {
          const pending = pendingRequests.get(requestId)
          if (pending) {
            clearTimeout(pending.timeout)
            pendingRequests.delete(requestId)
            if (msg.ok === false && msg.error) {
              pending.reject(new Error(msg.error as string))
            } else {
              pending.resolve(msg)
            }
          }
        }
        return
      }
      // Live broadcast: re-fetch the snapshot for the affected project
      if (msg.type === 'nightshift_event') {
        const projectUri = msg.project as string | undefined
        if (!projectUri) return
        const c = caches.get(projectUri)
        if (!c) return
        void fetchSnapshot(c)
      }
    },
  })
}

export interface NightshiftState {
  snapshot: NightshiftRunSnapshot | null | undefined
  loading: boolean
  error: string | null
  refetch: () => void
}

const EMPTY_STATE: NightshiftState = {
  snapshot: undefined,
  loading: false,
  error: null,
  refetch: () => {},
}

const stableSnapshots = new WeakMap<NightshiftCache, { version: number; state: NightshiftState }>()

function buildState(c: NightshiftCache): NightshiftState {
  const version = cacheVersions.get(c) ?? 0
  const cached = stableSnapshots.get(c)
  if (cached && cached.version === version) return cached.state
  const state: NightshiftState = {
    snapshot: c.snapshot,
    loading: c.loading,
    error: c.error,
    refetch: () => {
      c.inflightFetch = null
      void fetchSnapshot(c)
    },
  }
  stableSnapshots.set(c, { version, state })
  return state
}

export function useNightshift(projectUri: string | null): NightshiftState {
  useEffect(() => {
    installHandler()
  }, [])

  const state = useSyncExternalStore<NightshiftState>(
    onChange => {
      if (!projectUri) return () => {}
      const c = ensureCache(projectUri)
      c.subscribers.add(onChange)
      return () => c.subscribers.delete(onChange)
    },
    () => {
      if (!projectUri) return EMPTY_STATE
      return buildState(ensureCache(projectUri))
    },
    () => EMPTY_STATE,
  )

  useEffect(() => {
    if (!projectUri) return
    const c = ensureCache(projectUri)
    if (c.snapshot === undefined && !c.inflightFetch) {
      void fetchSnapshot(c)
    }
  }, [projectUri])

  return state
}
