/**
 * In-process event registry for the dispatcher BRAIN (plan-dispatcher-brain.md P2).
 *
 * The broker has no in-process event bus -- fleet events only fan out to WS
 * subscribers. But the dispatcher's memory engine must react to fleet activity
 * in the BACKGROUND (a turn ends, a conversation is spawned/ended, a live status
 * flips, a recap lands) whether or not anyone is chatting with the dispatcher.
 * This is that bus.
 *
 * Contract -- the hot path comes first:
 *  - FIRE is synchronous + cheap: it iterates handlers and returns. It NEVER
 *    awaits. A handler returning a promise has its rejection swallowed+logged.
 *  - Handlers must be cheap (enqueue + return). A throwing or slow handler can
 *    NOT break or block the conversation-store call that fired the event --
 *    every handler runs inside try/catch.
 *
 * Module singleton (mirrors desk/threads, desk/audit, desk/memory): the fire
 * sites call `emitDeskEvent`; the desk-memory service registers via
 * `onDeskEvent` at boot. No coupling to the 3k-line ConversationStore object.
 */

/** A background signal the dispatcher's memory engine consumes. PROJECT-anchored
 *  (the #1 anchor): `project` is the conversation's project URI, or null when a
 *  conversation has none yet (those are ignored by the memory engine). */
export type DeskEvent =
  | {
      kind: 'turn_complete'
      conversationId: string
      project: string | null
      ts: number
      /** Stop vs StopFailure -- a failed turn is still signal, flagged. */
      failed?: boolean
      title?: string
    }
  | {
      kind: 'lifecycle'
      conversationId: string
      project: string | null
      ts: number
      transition: 'created' | 'ended' | 'resumed'
      title?: string
    }
  | {
      kind: 'live_status'
      conversationId: string
      project: string | null
      ts: number
      /** status-tool's qualitative state: working | done | needs_you | blocked. */
      state: string
    }
  | {
      kind: 'recap_available'
      conversationId: null
      project: string
      ts: number
      recapId: string
      title?: string
    }

export type DeskEventKind = DeskEvent['kind']
export type DeskEventHandler = (event: DeskEvent) => void | Promise<void>

const handlers = new Set<DeskEventHandler>()

function logHandlerError(event: DeskEvent, err: unknown): void {
  console.warn(`[desk-events] handler for ${event.kind} threw:`, (err as Error)?.message ?? err)
}

/** Register a background handler. Returns an unsubscribe fn. */
export function onDeskEvent(handler: DeskEventHandler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/** Fire an event to every handler. Synchronous, non-blocking, never throws --
 *  safe to call from the conversation-store hot path. */
export function emitDeskEvent(event: DeskEvent): void {
  if (handlers.size === 0) return
  for (const h of handlers) {
    try {
      const r = h(event)
      if (r && typeof (r as Promise<void>).catch === 'function') {
        ;(r as Promise<void>).catch(err => logHandlerError(event, err))
      }
    } catch (err) {
      logHandlerError(event, err)
    }
  }
}

/** Number of registered handlers (test/introspection). */
export function deskEventHandlerCount(): number {
  return handlers.size
}

/** Drop all handlers -- test isolation + clean broker shutdown. */
export function clearDeskEventHandlers(): void {
  handlers.clear()
}
