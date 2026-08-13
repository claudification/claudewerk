/**
 * Sentinel PID registry -- surviving-child bookkeeping across sentinel restarts.
 *
 * The sentinel deliberately does NOT kill its agent hosts when it shuts down:
 * SIGTERM unrefs them so they outlive the restart (each host owns its own broker
 * WebSocket, so it keeps working while the sentinel is away). The registry file
 * is how the next sentinel instance rediscovers that previous generation.
 *
 * THE BUG THIS EXISTS TO KILL: startup used to probe each registry PID, log the
 * live ones, and then drop them on the floor -- they were never added to any
 * collection. Because the registry was serialised from `trackedChildren` alone
 * (which only holds hosts THIS instance spawned), the very next write erased
 * every survivor. So each restart abandoned a whole generation: 24 orphaned
 * hosts observed on one box, oldest 13 days, none of them in the registry.
 *
 * A survivor cannot be re-attached as a `Bun.Subprocess` -- that handle dies with
 * the old parent. But a raw PID is enough to do everything that actually matters:
 * persist it, probe it for liveness, and report it to the broker when it dies.
 * That is what `AdoptedChildren` holds.
 */

export interface PidRegistryEntry {
  conversationId: string
  pid: number
  cwd: string
  startedAt: string
}

/**
 * Liveness probe. Injected so tests never signal real processes -- and so a
 * caller can substitute a stricter check (e.g. also matching the command line)
 * without touching this module.
 */
export type AlivenessProbe = (pid: number) => boolean

/** Real probe: signal 0 is a permission/existence check that delivers nothing. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface ReconcileResult {
  /** Hosts that outlived the previous sentinel and are still running. */
  alive: PidRegistryEntry[]
  /** Hosts that died while no sentinel was watching; the broker must be told. */
  dead: PidRegistryEntry[]
}

/** Split a loaded registry into survivors to re-adopt and corpses to report. */
export function reconcileRegistry(entries: PidRegistryEntry[], isAlive: AlivenessProbe): ReconcileResult {
  const alive: PidRegistryEntry[] = []
  const dead: PidRegistryEntry[] = []
  for (const entry of entries) (isAlive(entry.pid) ? alive : dead).push(entry)
  return { alive, dead }
}

/**
 * Agent hosts inherited from a previous sentinel instance, tracked by PID only.
 *
 * Kept separate from `trackedChildren` because these have no `Subprocess` handle
 * and no stderr stream -- conflating them would mean every consumer of
 * `trackedChildren` had to null-check `proc`.
 */
export class AdoptedChildren {
  private readonly byConversation = new Map<string, PidRegistryEntry>()

  get size(): number {
    return this.byConversation.size
  }

  values(): PidRegistryEntry[] {
    return [...this.byConversation.values()]
  }

  /** Take ownership of survivors. Accumulates: earlier generations are kept. */
  adopt(entries: PidRegistryEntry[]): void {
    for (const entry of entries) this.byConversation.set(entry.conversationId, entry)
  }

  /**
   * Forget a conversation because this sentinel now owns a real child for it.
   * Without this a re-spawn would leave a stale PID shadowing the live one, and
   * a later reap would report the wrong process as dead.
   */
  release(conversationId: string): void {
    this.byConversation.delete(conversationId)
  }

  /** Drop survivors that have since exited, returning them so the caller can
   *  report each one to the broker exactly once. */
  prune(isAlive: AlivenessProbe): PidRegistryEntry[] {
    const reaped: PidRegistryEntry[] = []
    for (const [conversationId, entry] of this.byConversation) {
      if (isAlive(entry.pid)) continue
      reaped.push(entry)
      this.byConversation.delete(conversationId)
    }
    return reaped
  }
}

/**
 * Build the registry payload: this instance's own children plus every adopted
 * survivor. A tracked child WINS over an adopted record for the same
 * conversation -- the adopted PID is stale the moment we re-spawn it.
 */
export function mergeRegistryEntries(tracked: PidRegistryEntry[], adopted: PidRegistryEntry[]): PidRegistryEntry[] {
  const byConversation = new Map<string, PidRegistryEntry>()
  for (const entry of adopted) byConversation.set(entry.conversationId, entry)
  for (const entry of tracked) byConversation.set(entry.conversationId, entry)
  return [...byConversation.values()]
}
