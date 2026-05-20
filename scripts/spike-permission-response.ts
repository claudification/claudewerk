#!/usr/bin/env bun
/**
 * Spike 5 + Spike 6 -- live daemon probe for the daemon-followups plan.
 *
 *   Spike 5: discover the `permission-response` request schema by driving a
 *            real Haiku worker into a tool-gate, capturing `JobRecord.needs`,
 *            and live-firing candidate shapes against the daemon socket until
 *            one ACKs.
 *
 *   Spike 6: fire `reply` against busy / idle / done / failed workers and
 *            record per-state acceptance / ENOREPLY boundaries.
 *
 * Cost ceiling: Haiku only, <$0.50 total. Every worker `claude rm`'d in
 * `finally` so no leaks. The daemon idle-exits once leases drop.
 *
 * Run by hand:
 *
 *     bun run scripts/spike-permission-response.ts
 *
 * Output is printed AND appended verbatim to scripts/spike-findings.md so the
 * commit-3 doc-comments can quote the exact daemon responses.
 */

import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchClaudeBgWorker, fetchJobState } from '../src/daemon-agent-host/launch-smoke-mirror'
import { request } from '../src/shared/cc-daemon/client'
import { list, ping, reply } from '../src/shared/cc-daemon/ops'
import { resolveControlSocket } from '../src/shared/cc-daemon/socket-path'

const HAIKU = 'claude-haiku-4-5-20251001'
const FINDINGS = join(import.meta.dir, 'spike-findings.md')

function logBoth(line: string): void {
  console.log(line)
  appendFileSync(FINDINGS, `${line}\n`)
}

function header(title: string): void {
  logBoth('')
  logBoth(`## ${title}`)
  logBoth('')
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(r => setTimeout(r, ms))
}

// fallow-ignore-next-line complexity
async function waitForState(
  sock: string,
  short: string,
  predicate: (state: string, needs: string | undefined) => boolean,
  timeoutMs: number,
): Promise<{ state: string; needs: string | undefined } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const resp = await list(sock)
      const job = resp.jobs.find(j => j.short === short)
      if (job && predicate(job.state, job.needs)) {
        return { state: job.state, needs: job.needs }
      }
    } catch (e) {
      logBoth(`  list error: ${(e as Error).message}`)
    }
    await sleep(500)
  }
  return null
}

async function removeJob(short: string): Promise<void> {
  try {
    const proc = Bun.spawn(['claude', 'rm', short], { stdout: 'pipe', stderr: 'pipe' })
    const code = await proc.exited
    if (code !== 0) {
      const err = await new Response(proc.stderr as ReadableStream).text()
      logBoth(`  claude rm ${short} exited ${code}: ${err.slice(0, 200)}`)
    } else {
      logBoth(`  cleaned up ${short}`)
    }
  } catch (e) {
    logBoth(`  claude rm threw: ${(e as Error).message}`)
  }
}

// fallow-ignore-next-line complexity
async function main(): Promise<void> {
  // Truncate findings file -- this script is the source of truth for the run.
  Bun.write(FINDINGS, `# Spike findings -- ${new Date().toISOString()}\n`).catch(() => {})

  let sock = resolveControlSocket()
  if (!sock) {
    logBoth('No daemon control socket. Dispatching a kick-start worker to wake the supervisor...')
  }

  // ---- Spike 5: permission-response ----
  header('Spike 5: permission-response')

  const cwd5 = mkdtempSync(join(tmpdir(), 'spike-perm-'))
  logBoth(`probe cwd: ${cwd5}`)

  const short5 = await dispatchClaudeBgWorker({
    cwd: cwd5,
    name: `spike-perm-${Math.random().toString(16).slice(2, 8)}`,
    // A prompt that requires a tool with a permission gate. /etc/test.txt
    // forces a Write tool gate outside the worker cwd -- claude --bg without
    // --dangerously-skip-permissions will block on a permission decision.
    prompt: 'Use the Write tool to create the file /etc/spike-test.txt with the content "spike". Then say done.',
    model: HAIKU,
  })
  logBoth(`worker dispatched: short=${short5}`)

  try {
    // Re-resolve in case the worker brought up the daemon.
    sock = resolveControlSocket()
    if (!sock) throw new Error('still no control socket after dispatch')
    logBoth(`control socket: ${sock}`)
    const pong = await ping(sock)
    logBoth(`ping ok=${pong.ok} version=${pong.ok ? pong.version : '?'} proto=${pong.ok ? pong.proto : '?'}`)

    // Wait for the worker to reach a state with a permission `needs`.
    logBoth('waiting for permission-gate state...')
    const result = await waitForState(
      sock,
      short5,
      (state, needs) => state === 'question' || state === 'blocked' || !!needs,
      90_000,
    )
    if (!result) {
      logBoth('TIMEOUT: worker never reached a permission-gate state in 90s')
    } else {
      logBoth(`gate observed: state=${result.state} needs=${JSON.stringify(result.needs)}`)
      const fullList = await list(sock)
      const job = fullList.jobs.find(j => j.short === short5)
      logBoth(`full JobRecord: ${JSON.stringify(job, null, 2)}`)

      // First-round candidates rejected with EUNKNOWN "expected string, received
      // undefined" -- daemon wants a string field. Try `text`, `response`,
      // `answer`, `reply`, `value` -- the daemon's `reply` op uses `text`.
      const nonce = (await list(sock)).jobs.find(j => j.short === short5)?.nonce
      const sessionId = (await list(sock)).jobs.find(j => j.short === short5)?.sessionId
      logBoth(`nonce=${nonce} sessionId=${sessionId}`)
      const candidates: Array<{ name: string; req: Record<string, unknown> }> = [
        // Try with nonce required.
        {
          name: 'C11: short+nonce+text:yes',
          req: { op: 'permission-response', short: short5, nonce, text: 'yes' },
        },
        // Try with sessionId.
        {
          name: 'C12: short+sessionId+text:yes',
          req: { op: 'permission-response', short: short5, sessionId, text: 'yes' },
        },
        // Try alternate op names.
        { name: 'C13: respond+short+text', req: { op: 'respond', short: short5, text: 'yes' } },
        { name: 'C14: permissionResponse+camel', req: { op: 'permissionResponse', short: short5, text: 'yes' } },
        // Try `answer` op (used by tools that need an answer to a question).
        { name: 'C15: answer+short+text', req: { op: 'answer', short: short5, text: 'yes' } },
        // Try a `prompt-response` shape -- the daemon labels the worker as `blocked` on a prompt.
        { name: 'C16: prompt-response+short+text', req: { op: 'prompt-response', short: short5, text: 'yes' } },
      ]

      for (const c of candidates) {
        logBoth('')
        logBoth(`-- ${c.name}`)
        logBoth(`   req: ${JSON.stringify(c.req)}`)
        try {
          const resp = await request(sock, c.req as { op: string })
          logBoth(`   resp: ${JSON.stringify(resp)}`)
          if (resp.ok) {
            logBoth(`   SUCCESS -- daemon accepted shape ${c.name}`)
            break
          }
        } catch (e) {
          logBoth(`   THREW: ${(e as Error).message}`)
        }
      }
    }
  } finally {
    await removeJob(short5)
  }

  // ---- Spike 6: reply ENOREPLY boundary ----
  header('Spike 6: reply ENOREPLY boundary')

  const cwd6 = mkdtempSync(join(tmpdir(), 'spike-reply-'))
  const short6 = await dispatchClaudeBgWorker({
    cwd: cwd6,
    name: `spike-reply-${Math.random().toString(16).slice(2, 8)}`,
    prompt: 'Count from 1 to 5 slowly, one number per line. Then say done.',
    model: HAIKU,
  })
  logBoth(`worker dispatched: short=${short6}`)

  try {
    sock = resolveControlSocket()
    if (!sock) throw new Error('control socket missing')

    // Fire reply WHILE busy.
    await sleep(500)
    const busyState = await fetchJobState(sock, short6)
    logBoth(`state at first reply attempt: ${busyState}`)
    const r1 = await reply(sock, short6, 'continue please').catch((e: Error) => ({ ok: false, error: e.message }))
    logBoth(`reply (busy?): ${JSON.stringify(r1)}`)

    // Wait until done/idle/failed, then reply.
    const settled = await waitForState(sock, short6, s => s === 'done' || s === 'idle' || s === 'failed', 90_000)
    logBoth(`settled state: ${settled?.state ?? 'TIMEOUT'}`)
    if (settled) {
      const r2 = await reply(sock, short6, 'one more thing').catch((e: Error) => ({ ok: false, error: e.message }))
      logBoth(`reply at state=${settled.state}: ${JSON.stringify(r2)}`)
    }
  } finally {
    await removeJob(short6)
  }

  logBoth('')
  logBoth('## Cleanup')
  // Final list -- assert no leaked spike jobs left.
  try {
    if (sock) {
      const final = await list(sock)
      const left = final.jobs.filter(j => j.name?.startsWith('spike-perm-') || j.name?.startsWith('spike-reply-'))
      logBoth(`leaked spike jobs: ${left.length} -- ${JSON.stringify(left.map(j => j.short))}`)
    }
  } catch (e) {
    logBoth(`final list failed: ${(e as Error).message}`)
  }
  logBoth('Spike complete.')
}

main().catch(err => {
  logBoth(`FATAL: ${err instanceof Error ? err.stack : String(err)}`)
  // Best-effort cleanup is handled via the per-spike try/finally above.
  process.exit(1)
})
