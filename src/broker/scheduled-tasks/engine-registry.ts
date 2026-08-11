/**
 * The running engine's handle, so routes can reach it.
 *
 * Routes are built during app construction; the engine starts later in boot (it
 * needs the store and the conversation registry). Rather than thread a
 * half-initialised reference through every router signature, the engine
 * registers itself here and `/run` looks it up at request time -- returning a
 * clean 503 if the scheduler is not up yet instead of throwing.
 *
 * One process, one engine. Deliberately tiny and boring.
 */

import type { ScheduledTaskEngine } from './engine'

let current: ScheduledTaskEngine | null = null

export function setScheduledTaskEngine(engine: ScheduledTaskEngine | null): void {
  current = engine
}

export function getScheduledTaskEngine(): ScheduledTaskEngine | null {
  return current
}
