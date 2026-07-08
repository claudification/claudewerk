import type { BgTaskInfo, Conversation } from '../../../shared/protocol'

/** A single task from the agent host's neutral snapshot. */
export interface BgTaskSnapshotItem {
  id: string
  kind: 'shell' | 'agent' | string
  description: string
}

/**
 * Reconcile a full running-set SNAPSHOT (from the agnostic `background_tasks`
 * message) against `conv.bgTasks`.
 *
 * Snapshot semantics (proven from real data): `snapshot` is the COMPLETE set of
 * currently-running background tasks -- not a delta. So:
 *   - every task in the snapshot is upserted and marked running + source 'host'
 *     (promoting any hook-created row of the same id -- the snapshot is now the
 *     authoritative completion signal for it),
 *   - any host-sourced task that is running but ABSENT from the snapshot has
 *     finished, so it is marked completed.
 *
 * Hook-sourced rows (PTY conversations that never emit a snapshot) are left
 * untouched -- their completion still flows through TaskOutput / TaskStop.
 *
 * Returns true if anything changed (caller broadcasts + persists).
 */
export function reconcileBackgroundTasks(conv: Conversation, snapshot: BgTaskSnapshotItem[], now: number): boolean {
  let changed = false
  const seen = new Set<string>()

  for (const item of snapshot) {
    if (!item.id) continue
    seen.add(item.id)
    const existing = conv.bgTasks.find(t => t.taskId === item.id)
    if (existing) {
      changed = upsertHostTask(existing, item) || changed
    } else {
      conv.bgTasks.push(makeHostBgTask(item, now))
      changed = true
    }
  }

  for (const task of conv.bgTasks) {
    if (task.source === 'host' && task.status === 'running' && !seen.has(task.taskId)) {
      task.status = 'completed'
      task.completedAt = now
      changed = true
    }
  }

  return changed
}

/**
 * Promote an existing row to host-governed + ensure it is running. Preserves the
 * richer metadata a hook row may already carry (a human `description` / real
 * `command`); only backfills from the snapshot when a field is empty. Returns
 * true if it mutated the row.
 */
function upsertHostTask(existing: BgTaskInfo, item: BgTaskSnapshotItem): boolean {
  let changed = false
  if (existing.source !== 'host') {
    existing.source = 'host'
    changed = true
  }
  if (existing.status !== 'running') {
    existing.status = 'running'
    existing.completedAt = undefined
    changed = true
  }
  if (!existing.kind && item.kind) {
    existing.kind = item.kind
    changed = true
  }
  if (!existing.description && item.description) {
    existing.description = item.description
    changed = true
  }
  return changed
}

function makeHostBgTask(item: BgTaskSnapshotItem, now: number): BgTaskInfo {
  // For a shell task the description IS the command; for an agent task there is
  // no shell command. Keep `command` bounded like the hook writer does.
  const command = item.kind === 'shell' ? item.description.slice(0, 100) : ''
  return {
    taskId: item.id,
    command,
    description: item.description,
    startedAt: now,
    status: 'running',
    kind: item.kind,
    source: 'host',
  }
}
