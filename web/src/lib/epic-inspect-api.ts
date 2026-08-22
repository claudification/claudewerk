/**
 * The BROKER-SIDE half of `/api/epic` -- `active`, `inspect`, `beat`,
 * `break_lease` and `delete`.
 *
 * Deliberately a separate module from `epic-run-api.ts`. That one holds the four
 * SENTINEL verbs the RUN button drives (start/get/pause/abort); these four are
 * answered by the broker from state it already holds and add no sentinel round
 * trip. Same route, different cost and different failure modes, so keeping the
 * two clients apart keeps a caller honest about which one it is paying for.
 */

// Consumers import these straight from @shared/protocol -- re-exporting them
// here would just be a second name for the same type.
import type { EpicActivityEntry, EpicInspectResult } from '@shared/protocol'

async function post<T>(body: Record<string, unknown>, pick: (json: Record<string, unknown>) => T, empty: T) {
  try {
    const res = await fetch('/api/epic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as Record<string, unknown>
    if (!json.ok) return { ok: false as const, error: String(json.error ?? `HTTP ${res.status}`), data: empty }
    return { ok: true as const, data: pick(json) }
  } catch (e) {
    return { ok: false as const, error: (e as Error).message, data: empty }
  }
}

const NO_ROWS: EpicActivityEntry[] = []

/**
 * Every run the broker can see, across every project this caller may read.
 *
 * Called ONCE on mount to prime the store. After that the `epic_activity`
 * broadcast keeps it current -- a badge that polled this would cost a request
 * every few seconds per open tab, forever, whether or not anything was running.
 */
export function fetchActiveRuns() {
  return post({ op: 'active' }, j => (j.active as EpicActivityEntry[]) ?? NO_ROWS, NO_ROWS)
}

/** Everything about ONE run: artifact, lease, DAG verdict, live seats, the last
 *  beats and the baton. The expensive read, for the pane you are looking at. */
export function inspectRun(project: string, epicId: string, beats = 12) {
  return post({ op: 'inspect', project, epicId, beats }, j => j.inspect as EpicInspectResult, null)
}

interface BeatReply {
  note: string
  actions: number
  spawned: string[]
  error?: string
}

/** Force a beat now instead of waiting up to 45s. A refusal is normal: it means
 *  the scheduled sweep is mid-tick, which is exactly when a second beat would
 *  race it past the concurrency ceiling. */
export function beatRun(project: string, epicId: string) {
  return post({ op: 'beat', project, epicId }, j => j.beat as BeatReply, null)
}

/** Release a stuck werk-master lease. Refuses a LIVE holder unless forced -- that
 *  is the difference between an unstick and shooting a run mid-generation. */
export function breakLease(project: string, epicId: string, reason: string, force = false) {
  return post({ op: 'break_lease', project, epicId, reason, force }, j => String(j.note ?? ''), '')
}

/**
 * DELETE a run: gone from the wall, from `list` and from the armed set, and it
 * does not come back on the next sweep or broker restart.
 *
 * RECOVERABLE -- the sentinel MOVES the tree to `.deleted/<id>-<ts>/` rather
 * than removing it, and the note says where. It never touches the epic's cards.
 *
 * Refused on a run that is still armed or running, and refused while ANY
 * conversation tagged with this epic is live -- stricter than `clear`, because
 * this one moves the artifact those seats are writing to.
 */
export function deleteEpicRun(project: string, epicId: string, reason: string) {
  return post({ op: 'delete', project, epicId, reason }, j => String(j.note ?? ''), '')
}
