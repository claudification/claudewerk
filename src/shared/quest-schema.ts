/**
 * QUEST substrate schema (plan-quest-engine §4, §13, §14) -- the on-disk +
 * wire shape of a QUEST projected as TypeScript. A quest = a petname-selected
 * set of board cards + a manifest folder. The artifact IS the API: the SENTINEL
 * writes these files (lease-watcher, like `.rclaude/project/` + `.nightshift/`),
 * screens/agents read them, and NO broker/orchestrator state exists that cannot
 * be rebuilt from manifest + cards on boot (§14).
 *
 * Storage shape (owned by src/shared/quest-store.ts):
 *   <project>/.rclaude/project/quests/<petname>/
 *     manifest.md        frontmatter scalars + `## Goal` + `## Acceptance` (json)
 *     log.md             append-only intent/completion/plan/steering entries
 *     artifacts/         graphics, plan docs, steering (free-form)
 *
 * Card-side: board cards carry a first-class `quest: <petname>` frontmatter key
 * (NOT a tag) -- membership is ORTHOGONAL to the card's lane (§4c).
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Delivery target ladder (§7). Declared per quest at intake; rewrites the
 *  completion predicate. Higher rung = stricter gate. */
export type QuestTarget = 'pr' | 'merged' | 'shipped'

/** Lifecycle of the quest as a whole. Orthogonal to any single card's lane. */
export type QuestStatus = 'intake' | 'armed' | 'running' | 'paused' | 'complete' | 'aborted'

/** Blessed-intake gate verdict (§1). `blessed` = the human signed off on the
 *  acceptance contracts; nothing dispatches until then. */
export type QuestGate = 'pending' | 'blessed' | 'rejected'

/** Append-only log entry kind (§3). `intent` serves the RESUMER; `completion`
 *  is machine-authored git facts + narrative; `plan`/`steering` are course
 *  corrections. The log is NEVER rewritten -- only appended (separate verb). */
export type QuestLogKind = 'intent' | 'completion' | 'plan' | 'steering'

// Allowed-value tables backing the coercers below. Internal: the public surface
// is the `asQuest*` helpers + the string-literal types, not these arrays.
const QUEST_TARGETS: QuestTarget[] = ['pr', 'merged', 'shipped']
const QUEST_STATUSES: QuestStatus[] = ['intake', 'armed', 'running', 'paused', 'complete', 'aborted']
const QUEST_GATES: QuestGate[] = ['pending', 'blessed', 'rejected']
const QUEST_LOG_KINDS: QuestLogKind[] = ['intent', 'completion', 'plan', 'steering']

/** Board lanes that count as TERMINAL for the §4c completion predicate. */
const TERMINAL_CARD_STATUSES = ['done', 'archived'] as const

// ---------------------------------------------------------------------------
// Manifest (manifest.md)
// ---------------------------------------------------------------------------

/**
 * One machine-checkable acceptance contract (§1). Authored BEFORE work starts;
 * the DONE-gate (P2) runs `command` and distrusts the worker. `id` ties a
 * contract to a card/leg; `command` MUST exit 0 for acceptance.
 */
export interface QuestAcceptanceContract {
  id: string
  command: string
  description?: string
}

/** The quest manifest -- the spine (§4b). Scalars live in frontmatter; `goal`
 *  and `contracts` live in the manifest body (see quest-store serializer). */
export interface QuestManifest {
  petname: string
  /** Canonical project URI the quest belongs to. */
  project: string
  goal: string
  target: QuestTarget
  status: QuestStatus
  gate: QuestGate
  contracts: QuestAcceptanceContract[]
  /** ISO timestamps. */
  created: string
  updated: string
  /** Set when status=aborted (§13) -- the reason stamped at kill time. */
  abortReason?: string
}

/** Patchable manifest fields (`update_quest`, §4e). The log is NEVER patched
 *  here -- append-only entries go through `quest_log_append`. */
export interface QuestManifestPatch {
  goal?: string
  target?: QuestTarget
  status?: QuestStatus
  gate?: QuestGate
  contracts?: QuestAcceptanceContract[]
  abortReason?: string
}

// ---------------------------------------------------------------------------
// Append-only log (log.md)
// ---------------------------------------------------------------------------

/** One append-only log entry (§3/§4e). Written by `quest_log_append` only. */
export interface QuestLogEntry {
  /** ISO timestamp. */
  ts: string
  kind: QuestLogKind
  /** Authoring conversation id (the leg). */
  convId: string
  body: string
}

// ---------------------------------------------------------------------------
// quest_status predicate (§4c / §11)
// ---------------------------------------------------------------------------

/** Per-card state in the completion predicate. */
export interface QuestCardState {
  slug: string
  status: string
  terminal: boolean
}

/**
 * The computed §4c predicate. v1 (this packet): report per-card states + a
 * boolean; the delivered-per-target integrator semantics come with a later
 * packet, so `complete` == every card terminal AND the quest is not aborted.
 */
export interface QuestStatusReport {
  petname: string
  target: QuestTarget
  status: QuestStatus
  cards: QuestCardState[]
  total: number
  terminalCount: number
  allTerminal: boolean
  /** v1: allTerminal && status !== 'aborted'. Target semantics refine later. */
  complete: boolean
}

// ---------------------------------------------------------------------------
// Defaults / coercion helpers (shared by store + tests)
// ---------------------------------------------------------------------------

export function asQuestTarget(v: unknown, fallback: QuestTarget = 'pr'): QuestTarget {
  return QUEST_TARGETS.includes(v as QuestTarget) ? (v as QuestTarget) : fallback
}
export function asQuestStatus(v: unknown, fallback: QuestStatus = 'intake'): QuestStatus {
  return QUEST_STATUSES.includes(v as QuestStatus) ? (v as QuestStatus) : fallback
}
export function asQuestGate(v: unknown, fallback: QuestGate = 'pending'): QuestGate {
  return QUEST_GATES.includes(v as QuestGate) ? (v as QuestGate) : fallback
}
export function asQuestLogKind(v: unknown, fallback: QuestLogKind = 'intent'): QuestLogKind {
  return QUEST_LOG_KINDS.includes(v as QuestLogKind) ? (v as QuestLogKind) : fallback
}

/** True if a board card lane counts as terminal for the completion predicate. */
export function isTerminalCardStatus(status: string): boolean {
  return (TERMINAL_CARD_STATUSES as readonly string[]).includes(status)
}
