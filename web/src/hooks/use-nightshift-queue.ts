/**
 * useNightshiftQueue -- the nightshift OUTLOOK data: tasks assigned to a project's
 * queue, awaiting a run. Decoupled from runs, so it works on a fresh project with
 * zero runs. Thin wrapper over the shared per-project resource.
 *
 * Wire:
 *   queue_list -> { ok, queue }   dequeue -> { ok, removed }
 *   nightshift_event { event:'queue_update' } -> re-fetch.
 */

import type { NightshiftQueueItem } from '@shared/nightshift-types'
import { createNightshiftResource } from './nightshift-resource'
import { sendNightshiftRpc } from './nightshift-rpc'

const resource = createNightshiftResource<NightshiftQueueItem[]>({
  op: 'queue_list',
  extract: resp => (resp.queue as NightshiftQueueItem[] | undefined) ?? [],
})

export interface NightshiftQueueState {
  queue: NightshiftQueueItem[] | undefined
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useNightshiftQueue(projectUri: string | null): NightshiftQueueState {
  const { data, loading, error, refetch } = resource.useResource(projectUri)
  return { queue: data, loading, error, refetch }
}

/**
 * NO `enqueueNightshiftTask` HERE ANY MORE, deliberately.
 *
 * The run's input is the `#nightshift` tag on a board card; the broker scans the
 * board and builds each task from the card at dispatch time. A web helper that
 * still wrote into `.nightshift/queue/` would be a door into a room the engine
 * no longer enters -- it would report success and the task would never run.
 * Both callers now write a card instead (`board-modals.tsx` tags an existing
 * one, `assign-tasks-dialog.tsx` files a new one).
 *
 * The READS below stay: the queue directory still holds entries filed before
 * the switch, and the only thing left to do with them is look at them and clear
 * them. Draining them properly is `nightshift-queue-drain`, deliberately a card
 * with a human on it.
 */

/** Remove one queued task by id. */
export async function dequeueNightshiftTask(projectUri: string, id: string): Promise<void> {
  await sendNightshiftRpc({ type: 'nightshift_request', project: projectUri, op: 'dequeue', dequeueId: id })
  await resource.refetch(projectUri)
}

/** Outcome of a manual Run-now trigger. `ok:false` carries why (e.g. empty queue, already running). */
export interface RunNightshiftResult {
  ok: boolean
  reason?: string
}

/**
 * Manually trigger the night run for a project's queue NOW. The `run` op is
 * intercepted in the broker -- it spawns the worker fleet directly (never relayed
 * to the sentinel). No refetch needed: the broker fans a `run_started` beat that
 * already refreshes the Result/queue views. A failed trigger (empty queue /
 * already running) comes back as `ok:false` + the reason via the rejected RPC.
 */
export async function runNightshiftNow(projectUri: string): Promise<RunNightshiftResult> {
  try {
    await sendNightshiftRpc({ type: 'nightshift_request', project: projectUri, op: 'run' })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
