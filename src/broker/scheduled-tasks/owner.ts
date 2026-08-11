/**
 * Who OWNS a schedule an agent created.
 *
 * A schedule is a spawn with nobody at the keyboard, and `ownerMaySpawn`
 * re-checks the owner's CURRENT grants at every single fire. So `createdBy` has
 * to be a real, live, spawn-capable user -- a conversation is not a principal,
 * and a name that does not resolve produces a schedule that looks armed in the
 * UI and then disarms itself after five silent dispatch failures.
 *
 * Rather than let that happen at 03:00, the same predicate the engine will
 * apply later is applied HERE, at create time, and a create that cannot name a
 * valid owner is refused outright.
 *
 * The user directory is INJECTED, like the engine's other seams, so the rules
 * can be tested without standing up the auth store.
 */

import { getAllUsers, getUser } from '../auth'
import { hasPermissionAnyCwd } from '../permissions'

export type OwnerResult = { ok: true; userName: string } | { ok: false; error: string }

export interface OwnerDirectory {
  /** Does this name belong to a registered user at all? */
  exists(name: string): boolean
  /** The exact predicate `wiring.ts#ownerMaySpawn` applies at every fire. */
  maySpawn(name: string): boolean
  /** Every user who could own a schedule right now. */
  spawnCapable(): string[]
}

const realOwnerDirectory: OwnerDirectory = {
  exists: name => getUser(name) !== undefined,
  maySpawn(name) {
    const user = getUser(name)
    if (!user || user.revoked) return false
    return hasPermissionAnyCwd(user.grants ?? [], 'spawn')
  },
  spawnCapable() {
    return getAllUsers()
      .filter(u => !u.revoked)
      .map(u => u.name)
      .filter(name => this.maySpawn(name))
  },
}

/**
 * Resolve the principal a schedule will run as.
 *
 * An explicit name is verified, never trusted. With no name, a SINGLE
 * spawn-capable user is unambiguous and is used; more than one is not, and the
 * caller is told to say which -- guessing there would silently pin someone
 * else's permissions to work they never authorised.
 */
export function resolveScheduleOwner(explicit?: string, dir: OwnerDirectory = realOwnerDirectory): OwnerResult {
  const named = explicit?.trim()
  if (named) {
    if (!dir.exists(named)) return { ok: false, error: `owner "${named}" is not a registered user` }
    if (!dir.maySpawn(named)) {
      return { ok: false, error: `owner "${named}" does not have spawn permission, so the schedule could never fire` }
    }
    return { ok: true, userName: named }
  }

  const candidates = dir.spawnCapable()
  if (candidates.length === 1) return { ok: true, userName: candidates[0] }
  if (candidates.length === 0) {
    return { ok: false, error: 'no registered user holds spawn permission, so a schedule could never fire' }
  }
  return {
    ok: false,
    error: `several users could own this (${candidates.join(', ')}) -- pass owner to say which one it runs as`,
  }
}
