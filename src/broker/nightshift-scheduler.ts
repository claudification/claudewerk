/**
 * NIGHTSHIFT scheduler -- arms the Night Run engine on a per-project time window.
 *
 * Every minute it walks `listProjects()` and, for any project whose config is
 * `enabled` with a clock window that the local time currently falls inside, opens
 * a scheduler-triggered run (once per calendar day). Config is read through the
 * owning sentinel and cached per project (TTL) so the tick never hammers the
 * sentinel. Default config is `enabled:false`, so NOTHING fires until a project is
 * explicitly armed -- the scheduler is inert out of the box.
 *
 * The orchestrator (nightshift-orchestrator.ts) does the actual dispatch + drain;
 * this module only decides WHEN to call `runNightshift(..., {trigger:'scheduler'})`.
 */

import { DEFAULT_NIGHTSHIFT_CONFIG, type NightshiftConfig } from '../shared/nightshift-types'
import type { ConversationStore } from './conversation-store'
import { sendNightshiftOp } from './nightshift-broker-rpc'
import { isNightshiftRunActive, runNightshift } from './nightshift-orchestrator'
// withinWindow moved to the shared pure module; re-exported here for callers/tests.
import { withinWindow } from './nightshift-window'
import { listProjects } from './project-store'

export { withinWindow }

/** Cadence of the scheduling tick. */
const TICK_MS = 60_000
/** One config RPC per project per this interval (avoid hammering the sentinel). */
const CONFIG_TTL_MS = 10 * 60 * 1000

/** Local calendar-day key (YYYY-M-D) so a project schedules at most once per day. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** Time-gate: armed config whose clock window the local time currently falls in. */
export function shouldSchedule(config: NightshiftConfig, date: Date): boolean {
  return Boolean(config.enabled && config.window && withinWindow(config.window, date))
}

interface CachedConfig {
  config: NightshiftConfig
  fetchedAt: number
}

/**
 * Start the scheduler tick. Returns `{stop}` to clear the interval (mirrors the
 * watchdog). `now` is injectable for tests; defaults to `Date.now`.
 */
export function startNightshiftScheduler(
  store: ConversationStore,
  opts: { now?: () => number } = {},
): { stop: () => void } {
  const now = opts.now ?? Date.now
  const configCache = new Map<string, CachedConfig>()
  /** project_uri -> dayKey of its last scheduled run (the once-per-day guard). */
  const ranOn = new Map<string, string>()
  /** Projects with an in-flight `consider` so a slow RPC can't double-dispatch. */
  const considering = new Set<string>()

  /** A project's config: cached value within TTL, else a fresh sentinel read. */
  async function configFor(project: string): Promise<NightshiftConfig> {
    const cached = configCache.get(project)
    if (cached && now() - cached.fetchedAt < CONFIG_TTL_MS) return cached.config
    const res = await sendNightshiftOp(store, project, { op: 'config_read' })
    const config = (res.ok && res.config ? res.config : DEFAULT_NIGHTSHIFT_CONFIG) as NightshiftConfig
    configCache.set(project, { config, fetchedAt: now() })
    return config
  }

  /** Already running or mid-decision -- skip so a slow RPC can't double-dispatch. */
  function isBusy(project: string): boolean {
    return considering.has(project) || isNightshiftRunActive(project)
  }

  /** Decide + maybe fire for one project. Marks `ranOn` BEFORE the await. */
  async function consider(project: string, date: Date): Promise<void> {
    if (isBusy(project)) return
    const config = await configFor(project)
    if (!shouldSchedule(config, date)) return
    const today = dayKey(date)
    if (ranOn.get(project) === today) return
    ranOn.set(project, today)
    considering.add(project)
    try {
      const out = await runNightshift(store, project, { trigger: 'scheduler' })
      console.log(`[nightshift-sched] scheduled ${project}:`, {
        runId: out.runId,
        dispatched: out.dispatched,
        error: out.error,
        skipped: out.skipped,
      })
    } finally {
      considering.delete(project)
    }
  }

  function tick(): void {
    const date = new Date(now())
    for (const p of listProjects()) {
      consider(p.project_uri, date).catch(err =>
        console.error(`[nightshift-sched] consider crashed project=${p.project_uri}:`, err),
      )
    }
  }

  tick() // run once on boot
  const timer = setInterval(tick, TICK_MS)
  return { stop: () => clearInterval(timer) }
}
