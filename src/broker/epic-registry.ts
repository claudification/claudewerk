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

const armed = new Map<Key, ArmedEpic>()

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

/**
 * Rehydrate the armed set from the broker's own store. Call ONCE, at boot,
 * BEFORE `startEpicSweep` -- a sweep that ticks first would see an empty set and
 * beat nothing, which is the whole failure this exists to close.
 *
 * Rebuilds every map key through `key()` rather than trusting anything
 * persisted, so a set written by a broker with a different normalization rule
 * comes back normalized under the current one.
 */
export function initArmedEpics(store: KVStore): void {
  kv = store
  armed.clear()
  const raw = store.get<ArmedEpic[]>(KV_KEY)
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry?.project !== 'string' || typeof entry?.epicId !== 'string') continue
      armed.set(key(entry.project, entry.epicId), { project: entry.project, epicId: entry.epicId })
    }
  }
  // Logged even at zero: "rehydrated 0" and no line at all are different facts,
  // and the second one is what an unwired init looks like.
  console.log(
    `[epic-registry] rehydrated ${armed.size} armed epic(s) from the store` +
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

/** Tests only. Drops the store handle too, so a case that wired a KV cannot
 *  leak writes into the next one. */
export function resetArmedEpics(): void {
  armed.clear()
  kv = null
}
