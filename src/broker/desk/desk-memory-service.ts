/**
 * The always-on DESK MEMORY SERVICE (plan-dispatcher-brain.md P2+P3) -- the
 * engine that makes per-project memory MAINTAINED IN THE BACKGROUND, whether or
 * not anyone is chatting with the dispatcher.
 *
 * It subscribes to the in-process event registry (P2), turns each fleet signal
 * into one raw line of per-project memory (project-memory.ts), and -- debounced
 * + coalesced per project so a busy fleet never thrashes the LLM -- runs the
 * Haiku condenser (P3) to fold that signal into the durable brief and prune the
 * raw log. On a project's first condense it backfills from existing recaps (D51).
 *
 * Deps-injected (chat / recaps / clock) so it is testable without a live broker;
 * index.ts wires the real OpenRouter chat + recap orchestrator at boot.
 */

import { extractProjectLabel } from '../../shared/project-uri'
import type { ChatFn } from './classify'
import { condenseBrief } from './condenser'
import { type DeskEvent, onDeskEvent } from './event-registry'
import { ensureBriefRow, getBrief, getPendingEvents, recordRawEvent, writeBrief } from './project-memory'
import { projectKeyOf } from './projects'

export interface DeskMemoryDeps {
  chat: ChatFn
  /** Recaps for a project (most recent first) -- the cold-start seed (D51). */
  listRecaps?: (projectUri: string, limit: number) => Array<{ title?: string; subtitle?: string }>
  now?: () => number
  /** Quiet window after the last signal before condensing (ms). */
  debounceMs?: number
  /** Condense immediately once this many raw events are pending. */
  volumeTrigger?: number
}

interface Resolved {
  chat: ChatFn
  listRecaps: (projectUri: string, limit: number) => Array<{ title?: string; subtitle?: string }>
  now: () => number
  debounceMs: number
  volumeTrigger: number
}

let deps: Resolved | null = null
let unsubscribe: (() => void) | null = null
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const seeded = new Set<string>()
const inFlight = new Set<string>()
/** projectKey -> {uri,label} so the timer/force path can condense without the event. */
const known = new Map<string, { uri: string; label: string }>()

/** A raw, transient one-liner for a fleet event. The condenser DISTILLS these. */
export function summarizeEvent(e: DeskEvent): string {
  const title = 'title' in e ? e.title : undefined
  const who = e.kind === 'recap_available' ? '' : (title ?? e.conversationId?.slice(0, 8) ?? 'a conversation')
  switch (e.kind) {
    case 'turn_complete':
      return `turn ended in ${who}${e.failed ? ' (failed)' : ''}`
    case 'lifecycle':
      return e.transition === 'created'
        ? `spawned conversation ${who}`
        : e.transition === 'ended'
          ? `conversation ${who} ended`
          : `conversation ${who} revived`
    case 'live_status':
      return `${who} is now ${e.state}`
    case 'recap_available':
      return `recap available${e.title ? `: ${e.title}` : ''}`
  }
}

function handleEvent(e: DeskEvent): void {
  if (!deps || !e.project) return
  const projectKey = projectKeyOf(e.project)
  if (!projectKey) return
  const label = extractProjectLabel(e.project)
  known.set(projectKey, { uri: e.project, label })
  const pending = recordRawEvent({
    projectKey,
    projectUri: e.project,
    label,
    kind: e.kind,
    conversationId: e.conversationId,
    summary: summarizeEvent(e),
    ts: e.ts,
  })
  if (pending >= deps.volumeTrigger) {
    scheduleCondense(projectKey, 0)
  } else {
    scheduleCondense(projectKey, deps.debounceMs)
  }
}

function scheduleCondense(projectKey: string, delayMs: number): void {
  const existing = timers.get(projectKey)
  if (existing) clearTimeout(existing)
  const t = setTimeout(() => {
    timers.delete(projectKey)
    void condenseProjectNow(projectKey).catch(() => {})
  }, delayMs)
  // Don't keep the broker event loop alive on this maintenance timer.
  ;(t as { unref?: () => void }).unref?.()
  timers.set(projectKey, t)
}

function collectRecapExcerpts(projectUri: string): string[] {
  if (!deps?.listRecaps) return []
  return deps
    .listRecaps(projectUri, 5)
    .map(r => [r.title, r.subtitle].filter(Boolean).join(' — '))
    .filter(Boolean)
}

/**
 * Condense one project's pending signal into its durable brief NOW. Idempotent
 * and re-entrancy-safe. Also the force path the tools (A4/A6) call. Returns
 * true when it wrote a brief.
 */
export async function condenseProjectNow(projectKey: string, uriHint?: string, labelHint?: string): Promise<boolean> {
  if (!deps || inFlight.has(projectKey)) return false
  const meta =
    known.get(projectKey) ?? (uriHint ? { uri: uriHint, label: labelHint ?? extractProjectLabel(uriHint) } : null)
  if (!meta) return false
  if (uriHint) known.set(projectKey, meta)

  const events = getPendingEvents(projectKey)
  const firstSeed = !seeded.has(projectKey)
  let recapExcerpts: string[] | undefined
  if (firstSeed) {
    seeded.add(projectKey)
    recapExcerpts = collectRecapExcerpts(meta.uri)
  }
  if (events.length === 0 && !recapExcerpts?.length) return false

  inFlight.add(projectKey)
  try {
    // Backfill path may have no row yet (no raw event created it).
    ensureBriefRow(projectKey, meta.uri, meta.label, deps.now())
    const current = getBrief(projectKey)
    const next = await condenseBrief(
      {
        label: meta.label || current?.label || meta.uri,
        projectUri: meta.uri,
        currentBrief: current?.brief ?? '',
        events,
        recapExcerpts,
      },
      deps.chat,
    )
    writeBrief({
      projectKey,
      brief: next,
      now: deps.now(),
      upToEventId: events.length ? events[events.length - 1].id : undefined,
    })
    return true
  } finally {
    inFlight.delete(projectKey)
  }
}

/** Start the always-on service: subscribe to the event bus. */
export function startDeskMemoryService(d: DeskMemoryDeps): void {
  deps = {
    chat: d.chat,
    listRecaps: d.listRecaps ?? (() => []),
    now: d.now ?? Date.now,
    debounceMs: d.debounceMs ?? 45_000,
    volumeTrigger: d.volumeTrigger ?? 8,
  }
  unsubscribe?.()
  unsubscribe = onDeskEvent(handleEvent)
}

export function stopDeskMemoryService(): void {
  unsubscribe?.()
  unsubscribe = null
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  seeded.clear()
  inFlight.clear()
  known.clear()
  deps = null
}
