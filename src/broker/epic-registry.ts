/**
 * WHICH EPICS THE SWEEP SHOULD LOOK AT -- the fix for a chicken-and-egg the
 * first live smoke found on 2026-08-18.
 *
 * The sweep discovered epics by grouping CONVERSATIONS that carry
 * `launchConfig.epic`. That works perfectly from the second beat onward and is
 * completely useless for the first: a freshly armed run has no conversations, so
 * `groupEpicConversations` returned an empty map, `sweepEpics` returned at
 * `groups.size === 0`, and the run sat `armed` forever with nothing to notice
 * it. The engine could only find epics that were already running.
 *
 * So arming an epic REGISTERS it here, and the sweep unions this set with what
 * it can see in the conversation registry. Terminal ops drop it again.
 *
 * DURABLE SINCE 2026-08-21, and the comment that used to sit here is why it took
 * so long. It said a restart only lost "the gap between armed and first
 * dispatch", which is FALSE and was the reason nobody treated this as urgent:
 * the sweep's union means a run survives a restart exactly as long as it still
 * has a LIVE CONVERSATION, and a healthy run is momentarily conversation-less
 * between every pair of beats. The real lossy window was "any moment the run
 * happens to be idle" -- most of a run's wall-clock life. Worse, the failure is
 * DELAYED: work continues right after the restart and the run dies quietly
 * minutes later when the last seat exits. `epic-the-wall` died exactly that way
 * on 2026-08-19 (restart 16:12:13Z, last seat 16:23:33Z, then nothing).
 *
 * THE COVENANT IS UNTOUCHED. Rehydrating does NOT mean the broker scans
 * `.rclaude/project/epics/` -- CWD IS INFORMATIONAL still holds, the sentinel
 * still owns files. The broker never DISCOVERS the armed set; it was TOLD it by
 * the `start` op, and it writes that fact back into its own store (`kv`, the
 * same table settings/links/shares already live in) so it can be told again on
 * boot. Two strings per run, no filesystem question asked.
 *
 * ONE KV KEY HOLDING THE WHOLE SET, not one key per epic. The obvious
 * `kv.set('epic:armed:<key>')` + `keysByPrefix` shape does not survive contact
 * with the map key, which is NUL-joined: a bound key containing `\0` does not
 * round-trip through `bun:sqlite` at all (verified 2026-08-21 -- the row comes
 * back from neither an exact `WHERE key = ?` nor a `LIKE 'epic:armed:%'`, so
 * arming would have looked fine and rehydrated nothing). A NUL-free separator
 * would need a character no project path can contain, which is not a promise a
 * path can make. Storing the array and rebuilding every key through `key()` at
 * hydration also makes normalization true BY CONSTRUCTION: the persisted form
 * cannot disagree with the read path about spelling, because it does not carry a
 * key at all.
 */

import { projectIdentityKey } from '../shared/project-uri'
import type { KVStore } from './store/types'

export interface ArmedEpic {
  /** The RAW URI the caller armed with, kept verbatim -- it is what gets passed
   *  back out to the sweep and onward to the sentinel. Only the map KEY is
   *  normalized; this is a comparison fix, not a storage change. */
  project: string
  epicId: string
}

/** A run somebody DELETED, remembered as the same (project, epicId) pair. An
 *  alias rather than a second interface, so a signature can still say which of
 *  the two questions it is about. */
export type DeletedEpic = ArmedEpic

/** `${projectIdentityKey(project)}\0${epicId}` -- a NUL join, since neither part
 *  can contain one.
 *
 *  KEYED ON PROJECT IDENTITY, not on the raw string. `start` is reached from an
 *  MCP call that types `claude:///path`, while the store and every canonical
 *  writer say `claude://default/path`; a raw-string key made a run armed under
 *  one spelling invisible to `isArmed`/`forgetArmedEpic` under the other, so
 *  `epic_run action=list` reported no runs while `inspect` showed a live one. */
type Key = string

const KV_KEY = 'epic:armed'

/**
 * THE TOMBSTONE SET -- runs a human deleted, so no surface resurrects them.
 *
 * A deleted run's ARTIFACT is gone (moved to `.deleted/`), but the broker does
 * not find runs on disk: it finds them by grouping CONVERSATIONS that carry an
 * epic launch tag, and the registry keeps conversations long after they end. So
 * deleting the tree alone leaves exactly the phantom `epicsToWatch` already
 * documents one file over -- a permanent group with no `run.md`, beaten every
 * 45s forever and rendered on every surface that lists runs.
 *
 * Same storage shape and the same covenant as the armed set above: two strings
 * per run in the broker's own `kv`, never a filesystem question. Re-arming an
 * epic clears its tombstone, because a run that started again is a real run.
 */
const DELETED_KV_KEY = 'epic:deleted'

const armed = new Map<Key, ArmedEpic>()
const deleted = new Map<Key, DeletedEpic>()

/** Null until the broker boots (and in every test that does not care). Absent
 *  means memory-only, exactly the old behaviour -- never a throw, because a
 *  broker running without a store driver must still be able to arm a run. */
let kv: KVStore | null = null

function key(project: string, epicId: string): Key {
  return `${projectIdentityKey(project)}\0${epicId}`
}

function save(): void {
  kv?.set(KV_KEY, [...armed.values()])
}

function saveDeleted(): void {
  kv?.set(DELETED_KV_KEY, [...deleted.values()])
}

/** One persisted list -> one map, keys rebuilt through `key()` rather than
 *  trusted, so a set written by a broker with a different normalization rule
 *  comes back normalized under the current one. */
function hydrate(store: KVStore, kvKey: string, into: Map<Key, ArmedEpic>): void {
  into.clear()
  const raw = store.get<ArmedEpic[]>(kvKey)
  if (!Array.isArray(raw)) return
  for (const entry of raw) {
    if (typeof entry?.project !== 'string' || typeof entry?.epicId !== 'string') continue
    into.set(key(entry.project, entry.epicId), { project: entry.project, epicId: entry.epicId })
  }
}

/**
 * Rehydrate the armed set -- AND the tombstone set beside it -- from the
 * broker's own store. Call ONCE, at boot, BEFORE `startEpicSweep`: a sweep that
 * ticks first would see an empty armed set and beat nothing, which is the whole
 * failure this exists to close, and an empty tombstone set would resurrect every
 * deleted run for exactly one boot.
 */
export function initArmedEpics(store: KVStore): void {
  kv = store
  hydrate(store, KV_KEY, armed)
  hydrate(store, DELETED_KV_KEY, deleted)
  // Logged even at zero: "rehydrated 0" and no line at all are different facts,
  // and the second one is what an unwired init looks like.
  console.log(
    `[epic-registry] rehydrated ${armed.size} armed epic(s) and ${deleted.size} deleted run(s) from the store` +
      (armed.size > 0 ? `: ${[...armed.values()].map(a => a.epicId).join(', ')}` : ''),
  )
}

/** Arming an epic. Called by the `start` op, idempotent. */
export function noteArmedEpic(project: string, epicId: string): void {
  armed.set(key(project, epicId), { project, epicId })
  save()
}

/** Terminal or paused: stop sweeping it. Called by pause/abort/complete/park. */
export function forgetArmedEpic(project: string, epicId: string): void {
  if (armed.delete(key(project, epicId))) save()
}

export function listArmedEpics(): ArmedEpic[] {
  return [...armed.values()]
}

export function isArmed(project: string, epicId: string): boolean {
  return armed.has(key(project, epicId))
}

/** A run was deleted: never watch it, never list it, never beat it again.
 *  Called by `actionDelete` AFTER the sentinel confirms the move, never before
 *  -- a tombstone for a delete the sentinel refused would hide a live run. */
export function noteDeletedEpic(project: string, epicId: string): void {
  deleted.set(key(project, epicId), { project, epicId })
  saveDeleted()
}

/** UN-delete. Arming an epic id again means there is a real run behind it, and a
 *  tombstone left in place would make the new run invisible on every surface --
 *  the exact failure `startEpicRun` wiping `acknowledgedAt` guards against, one
 *  layer up. */
export function forgetDeletedEpic(project: string, epicId: string): void {
  if (deleted.delete(key(project, epicId))) saveDeleted()
}

export function isDeletedEpic(project: string, epicId: string): boolean {
  return deleted.has(key(project, epicId))
}

export function listDeletedEpics(): DeletedEpic[] {
  return [...deleted.values()]
}

/** Tests only. Drops the store handle too, so a case that wired a KV cannot
 *  leak writes into the next one. */
export function resetArmedEpics(): void {
  armed.clear()
  deleted.clear()
  kv = null
}
