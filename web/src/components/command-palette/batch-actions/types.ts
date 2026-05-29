import type { Conversation } from '@/lib/types'

export interface BatchActionRunResult {
  conversationId: string
  ok: boolean
  error?: string
  detail?: string
}

/** Static metadata describing one batch action. */
export interface BatchActionDescriptor {
  id: string
  label: string
  description?: string
  /** Whether the action surfaces a second-step form before run (e.g. broadcast
   *  needs a textarea; reassign needs target dropdowns). Undefined = no form. */
  requiresInput?: 'broadcast' | 'reassign'
  /** True if the action requires a confirm modal (type-to-confirm when N is large). */
  needsConfirm?: boolean
}

export interface BatchActionRunContext {
  ids: string[]
  conversations: Conversation[]
  batchId: string
  /** Optional payload from the action's input form (broadcast message, reassign
   *  target, etc). Action-specific shape; each action narrows it internally. */
  input?: unknown
}

/** Result-stream produced by `run()`. Implementations should yield one entry
 *  per conversation as it settles so the UI can update incrementally. */
export type BatchActionRun = (ctx: BatchActionRunContext) => AsyncIterable<BatchActionRunResult>

export interface BatchAction extends BatchActionDescriptor {
  run: BatchActionRun
}

/** Bounded fan-out runner. Caps concurrency at `limit` so we don't trample the
 *  broker with 50 concurrent WS frames. Yields each result as its task settles
 *  (not in input order). */
export async function* runWithConcurrency<T>(
  ids: string[],
  limit: number,
  task: (id: string) => Promise<T>,
): AsyncIterable<T> {
  const queue = [...ids]
  const inflight = new Map<number, Promise<{ key: number; value: T }>>()
  let nextKey = 0

  function start(id: string): void {
    const key = nextKey++
    inflight.set(
      key,
      task(id).then(value => ({ key, value })),
    )
  }

  for (let i = 0; i < Math.min(limit, queue.length); i++) {
    const id = queue.shift()
    if (id !== undefined) start(id)
  }

  while (inflight.size > 0) {
    // intentional custom bounded-concurrency pool -- await Promise.race inside while IS the design
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    // intentional custom bounded-concurrency pool -- await Promise.race inside while IS the design
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const settled = await Promise.race(inflight.values())
    inflight.delete(settled.key)
    yield settled.value
    const next = queue.shift()
    if (next !== undefined) start(next)
  }
}
