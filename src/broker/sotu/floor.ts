/**
 * SOTU deterministic lifecycle floor (Phase 1).
 *
 * The chronicle must NOT depend on voluntary `<callout>` emission -- so the broker
 * appends its OWN lifecycle events as a baseline contribution stream. This is that
 * floor: a background subscriber on the in-process desk-event bus (the same bus the
 * dispatcher's memory engine rides) that turns every `lifecycle` event into a
 * `LifecycleContrib` on the relevant project's queue. Zero LLM, always on.
 *
 * Boundary: consumes broker-owned desk events (conversationId + project URI only);
 * never parses CC output, never reads ccSessionId.
 */

import { onDeskEvent } from '../desk/event-registry'
import { recordContribution } from './contribute'
import { projectSlug } from './paths'
import type { LifecycleContrib } from './types'

let unsubscribe: (() => void) | null = null

/** Start the floor: subscribe to desk lifecycle events and append each as a
 *  contribution. Idempotent -- a second call is a no-op while already running. */
export function startSotuFloor(): void {
  if (unsubscribe) return
  unsubscribe = onDeskEvent(event => {
    // Only lifecycle transitions are the floor; turn/status/recap events are
    // surfaced by their own seams (callouts, git scan, distill). A conversation
    // with no project yet has nowhere to file the contribution.
    if (event.kind !== 'lifecycle' || !event.project) return
    const contrib: LifecycleContrib = {
      kind: 'lifecycle',
      convId: event.conversationId,
      ts: event.ts,
      event: event.transition,
    }
    recordContribution(projectSlug(event.project), contrib)
  })
}

/** Stop the floor (clean broker shutdown + test isolation). */
export function stopSotuFloor(): void {
  unsubscribe?.()
  unsubscribe = null
}
