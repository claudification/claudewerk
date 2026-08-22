import type { Conversation } from '@/lib/types'

/**
 * MANAGED — conversations nobody asked for.
 *
 * Pulse answers "what am I working on". An unattended run dispatched by the
 * machine is not that, and a live epic can field several seats at once, so
 * leaving them in drowns the human's own work in traffic they never started.
 * They are hidden BY DEFAULT here and revealed with `+over`.
 *
 * That default is specific to THIS surface. A managed run must never be
 * invisible everywhere at once -- the werk-master header badge stays loud about
 * the aggregate; Pulse only declines to list the individual seats.
 *
 * THE TRUST RULE, and the reason this reads `epic`/`nightshift` rather than any
 * agent-writable field: both are BROKER-AUTHORED PROVENANCE, stamped at
 * dispatch by the thing that did the spawning. An agent's own self-report about
 * what it is doing (a `working_on`-style bag) is the wrong input for a decision
 * about whether to HIDE that agent -- it could be wrong, stale, or simply never
 * set, and a managed run would then surface in the human's list anyway. Never
 * key this off something the conversation under inspection can write.
 */

/** The three epic seats, all machine-dispatched. */
export type ManagedKind = 'epic' | 'nightshift'

export interface ManagedInfo {
  kind: ManagedKind
  /** Short chip label. `OVER` for the whole epic family -- deliberately not
   *  `EPIC`, which collides with the Kanban card `epic:` key and would read as
   *  "about an epic" rather than "run by the machine". */
  label: string
  /** What groups sibling seats: the epic id, or the nightshift run id. */
  runId: string
  /** Epic seat role, when it is an epic. */
  role?: string
}

export function managedInfo(c: Conversation): ManagedInfo | undefined {
  if (c.epic) {
    return { kind: 'epic', label: 'OVER', runId: c.epic.epicId, role: c.epic.role }
  }
  if (c.nightshift) {
    return { kind: 'nightshift', label: 'NIGHT', runId: c.nightshift.runId }
  }
  return undefined
}

export function isManaged(c: Conversation): boolean {
  return managedInfo(c) !== undefined
}
