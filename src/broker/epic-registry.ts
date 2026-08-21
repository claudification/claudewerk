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
 * DELIBERATELY IN MEMORY, and this is the one caveat worth knowing: a broker
 * restart forgets every armed-but-not-yet-started epic. Rehydrating would mean
 * scanning every project's `.rclaude/project/epics/` on boot -- a filesystem
 * question the broker is not allowed to ask (CWD IS INFORMATIONAL / the sentinel
 * owns files). A run with live conversations survives a restart fine, because
 * those come back from the conversation store; only the gap between "armed" and
 * "first dispatch" is lossy, and re-arming is idempotent (`start` RESUMES).
 */

import { projectIdentityKey } from '../shared/project-uri'

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

const armed = new Map<Key, ArmedEpic>()

function key(project: string, epicId: string): Key {
  return `${projectIdentityKey(project)}\0${epicId}`
}

/** Arming an epic. Called by the `start` op, idempotent. */
export function noteArmedEpic(project: string, epicId: string): void {
  armed.set(key(project, epicId), { project, epicId })
}

/** Terminal or paused: stop sweeping it. Called by pause/abort/complete/park. */
export function forgetArmedEpic(project: string, epicId: string): void {
  armed.delete(key(project, epicId))
}

export function listArmedEpics(): ArmedEpic[] {
  return [...armed.values()]
}

export function isArmed(project: string, epicId: string): boolean {
  return armed.has(key(project, epicId))
}

/** Tests only. */
export function resetArmedEpics(): void {
  armed.clear()
}
