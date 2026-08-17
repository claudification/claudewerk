/**
 * Proves `detached: true` does the thing the sentinel is relying on, and that
 * omitting it leaves a child in the parent's process group.
 *
 * MEASURED on the live box 2026-08-17, before the fix: the sentinel and ~50
 * agent hosts all shared pgid 85594 -- the group of the shell that launched the
 * sentinel. One `kill -- -85594` would have killed every conversation.
 *
 * This is a behaviour test against Bun, not against our code, and that is the
 * point: the whole blast-radius argument rests on one spawn option, so it is
 * worth one test that fails loudly if a Bun upgrade changes it.
 */

import { describe, expect, test } from 'bun:test'

/** A child's process group, read from the OS rather than assumed. */
async function pgidOf(pid: number): Promise<number> {
  const proc = Bun.spawn(['ps', '-o', 'pgid=', '-p', String(pid)], { stdout: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return Number(out.trim())
}

/** Sleeps long enough to be inspected, and is killed the moment we are done. */
function sleeper(detached: boolean) {
  return Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore', ...(detached ? { detached: true } : {}) })
}

describe('host spawn detachment', () => {
  test('WITHOUT detached, a child shares our process group -- the old behaviour', async () => {
    const child = sleeper(false)
    try {
      expect(await pgidOf(child.pid)).toBe(await pgidOf(process.pid))
    } finally {
      child.kill()
    }
  })

  test('WITH detached, a child gets its own process group', async () => {
    const child = sleeper(true)
    try {
      const [childPgid, ourPgid] = await Promise.all([pgidOf(child.pid), pgidOf(process.pid)])
      expect(childPgid).not.toBe(ourPgid)
      // Its own group leader, so a signal to our group cannot reach it.
      expect(childPgid).toBe(child.pid)
    } finally {
      child.kill()
    }
  })

  test('signalling a process group kills its members -- which is the danger', async () => {
    // Signal a THROWAWAY group, never our own: the first draft of this test
    // SIGHUP'd the runner's group and took the whole suite down with it. That
    // is exactly the failure mode being demonstrated, but it makes a poor test.
    const leader = sleeper(true) // detached => it IS a group leader
    const groupPgid = await pgidOf(leader.pid)
    expect(groupPgid).toBe(leader.pid)

    process.kill(-groupPgid, 'SIGKILL')
    // Await the exit rather than re-reading `ps`: a killed-but-unreaped child
    // is a ZOMBIE, and `ps -o pgid=` still prints for it (0, not empty), so a
    // liveness check via ps reports the corpse as alive.
    await leader.exited
    expect(leader.signalCode).toBe('SIGKILL')

    // A host in its own group is unreachable from any OTHER group's signal,
    // which is the whole protection: to stop one you must name it.
    const bystander = sleeper(true)
    try {
      expect(await pgidOf(bystander.pid)).not.toBe(groupPgid)
    } finally {
      bystander.kill()
    }
  })
})
