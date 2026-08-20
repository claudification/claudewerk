/**
 * The promise ledger, fetched ON DEMAND, per project.
 *
 * NOT A WALL FEED. There is deliberately no `WallFeedId` and no wall-frame
 * channel for this: a verdict is a question about git, and pushing one on every
 * frame would put a `merge-base` per sha per project into the fleet's hot path
 * to move a pill that changes when a commit lands. The pane asks for the
 * projects it is actually showing and nothing else -- which is also why this
 * lives in `hooks/` rather than under `lib/wall/`: the project action panel is
 * the second caller and it is not on the wall at all.
 *
 * IT IS A MODULE-GLOBAL CACHE, not per-component state. P3 and the panel can be
 * on screen at once, and two components asking the same sentinel the same
 * question on their own clocks is two directory scans and two rounds of git for
 * one answer.
 *
 * `resp.ok === false` IS CHECKED, and that check is the whole reason this is not
 * three lines. A sentinel that does not know the `promises` op does not throw,
 * it REPLIES with `ok: false` -- and `resp.promises ?? []` would read that
 * refusal as "this project has no broken promises", which is the most dangerous
 * possible wrong answer from a feature whose entire job is refusing to report a
 * clean board that is not clean. `useWallPins` shipped that bug on 2026-08-20
 * and this is the same shape wearing the same scar.
 */

import type { PromiseLedger } from '@shared/promise-rows'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { installSharedHandler } from './project-task-cache'
import { sendBoardOp } from './project-task-wire'

/**
 * How often a project's ledger is re-asked.
 *
 * A verdict changes when a commit lands on main or a revert takes one off it --
 * a human-paced, minutes-apart event. Sixty seconds is far inside the lag
 * anybody could notice and far outside the rate at which a directory scan plus
 * two git spawns per sha is worth repeating.
 */
const LEDGER_POLL_MS = 60_000

export interface LedgerEntry {
  ledger: PromiseLedger | null
  /** What the sentinel said when it refused. Null when it answered. */
  error: string | null
  fetchedAt: number
}

const cache = new Map<string, LedgerEntry>()
const inflight = new Set<string>()
const subscribers = new Set<() => void>()

function notify(): void {
  for (const fn of subscribers) fn()
}

/** Drop everything. Tests only -- the cache is module-global on purpose. */
export function resetPromiseLedgerCache(): void {
  cache.clear()
  inflight.clear()
  notify()
}

/**
 * Ask one project, unless an ask is already out or the last answer is fresh.
 *
 * A REFUSAL NEVER OVERWRITES A GOOD LEDGER. It is recorded beside the last one,
 * so a sentinel that goes away mid-session leaves the rows on screen with a
 * reason attached rather than silently emptying the loud table.
 */
async function fetchLedger(projectUri: string, nowMs: number, force: boolean): Promise<void> {
  if (inflight.has(projectUri)) return
  const prev = cache.get(projectUri)
  if (!force && prev && nowMs - prev.fetchedAt < LEDGER_POLL_MS) return

  inflight.add(projectUri)
  try {
    const resp = await sendBoardOp(projectUri, 'promises')
    if (resp.ok === false) {
      const error = String(resp.error ?? 'the sentinel refused the `promises` op')
      cache.set(projectUri, { ledger: prev?.ledger ?? null, error, fetchedAt: nowMs })
    } else {
      cache.set(projectUri, {
        ledger: (resp.promises as PromiseLedger | undefined) ?? null,
        error: null,
        fetchedAt: nowMs,
      })
    }
    notify()
  } catch {
    // Disconnected or timed out. Keep whatever we have and ask again next tick;
    // a dropped socket is not evidence about anybody's promises.
  } finally {
    inflight.delete(projectUri)
  }
}

export interface PromiseLedgerFeed {
  /** One entry per requested project, in the order asked. Absent until answered. */
  byProject: Map<string, LedgerEntry>
  /** True while no project has answered yet -- the difference between "clean" and
   *  "not asked", which a table that renders emptiness must be able to say. */
  loading: boolean
  /** The first refusal, if any. An empty table plus this is "we cannot tell". */
  refused: string | null
  reload(): void
}

/**
 * Subscribe to the ledgers of a fixed set of projects.
 *
 * `projectUris` is joined into a string key rather than depended on as an array:
 * every caller builds the list with a `map` inside a render, so an effect keyed
 * on the array itself would refetch the whole fleet on every unrelated store
 * churn.
 */
export function usePromiseLedger(projectUris: readonly string[]): PromiseLedgerFeed {
  const key = useMemo(() => [...new Set(projectUris)].sort().join('\n'), [projectUris])
  const [version, setVersion] = useState(0)

  useEffect(() => {
    installSharedHandler()
  }, [])

  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    subscribers.add(bump)
    return () => {
      subscribers.delete(bump)
    }
  }, [])

  const load = useCallback(
    (force: boolean) => {
      const projects = key ? key.split('\n') : []
      for (const uri of projects) void fetchLedger(uri, Date.now(), force)
    },
    [key],
  )

  // A project entering the set is a new QUESTION, not a stale answer.
  useEffect(() => {
    load(false)
    if (!key) return
    const timer = setInterval(() => load(false), LEDGER_POLL_MS)
    return () => clearInterval(timer)
  }, [key, load])

  return useMemo(() => {
    void version
    const projects = key ? key.split('\n') : []
    const byProject = new Map<string, LedgerEntry>()
    let refused: string | null = null
    for (const uri of projects) {
      const entry = cache.get(uri)
      if (!entry) continue
      byProject.set(uri, entry)
      if (entry.error) refused ??= entry.error
    }
    return {
      byProject,
      loading: projects.length > 0 && byProject.size === 0,
      refused,
      reload: () => load(true),
    }
  }, [key, version, load])
}
