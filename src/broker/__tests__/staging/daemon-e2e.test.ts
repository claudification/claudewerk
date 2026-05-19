/**
 * End-to-end staging test for the daemon agent host (NEW mode).
 *
 * Plays the sentinel's NEW-mode dispatch by hand: dispatches a `claude --bg`
 * Haiku worker, captures its short id, then spawns the real bin/daemon-host
 * binary pointed at the live staging broker and at that worker. Asserts that:
 *   - agent_host_boot is accepted (broker creates a daemon conversation)
 *   - the daemon-host attaches to the worker and derives its ccSessionId
 *   - the worker's transcript is mirrored to the broker (assistant reply lands)
 *   - /diag reports agentHostType 'daemon' + the captured ccSessionId
 *
 * Requires:
 *   STAGING_BROKER_URL=localhost:19999
 *   STAGING_SECRET=<hex>
 *   bin/daemon-host built (run `bun run build:daemon-agent-host`)
 *   a reachable Claude Code daemon (`claude daemon` running)
 *
 * Skipped when any of those are missing -- safe to leave in the staging suite.
 * Adds ~30-60s to a staging run when enabled (Haiku worker turn latency).
 *
 * The worker is dispatched with the Haiku model in a bare temp cwd to keep
 * the probe cheap (~85k subscription-billed tokens) and is `claude rm`'d after.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { resolveControlSocket } from '../../../shared/cc-daemon/socket-path'
import { cleanup, connectDashboard, getBrokerSecret, httpGet, sleep, testId, waitForMatch, waitForMessage } from './staging-harness'

const STAGING_AVAILABLE = !!(process.env.STAGING_BROKER_URL && process.env.STAGING_SECRET)
const DAEMON_BIN = resolvePath(process.cwd(), 'bin/daemon-host')
const HAVE_BIN = existsSync(DAEMON_BIN)
const HAVE_DAEMON = resolveControlSocket() != null

const run = STAGING_AVAILABLE && HAVE_BIN && HAVE_DAEMON ? describe : describe.skip

const HAIKU = 'claude-haiku-4-5-20251001'
const PROBE = 'Reply with exactly: PROBE-DAEMON-OK and nothing else.'

/** Strip ANSI escapes so the `backgrounded - <id>` line can be matched. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars.
const ANSI_RE = /\[[0-9;]*m/g

/** Extract the 8-hex worker short id from `claude --bg` output. */
function parseShort(output: string): string | null {
  const m = output.replace(ANSI_RE, '').match(/backgrounded\s+\W+\s*([0-9a-f]{8})/)
  return m ? m[1] : null
}

/** Dispatch a `claude --bg` Haiku worker in `cwd`; return its short id. */
async function dispatchWorker(cwd: string, name: string): Promise<string> {
  const proc = Bun.spawn(['claude', '--bg', '--model', HAIKU, '--name', name, PROBE], {
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  const short = parseShort(`${out}${err}`)
  if (!short) throw new Error(`claude --bg printed no short id: ${`${out}${err}`.slice(0, 200)}`)
  return short
}

/** Remove a probe worker job -- only ever a short this test dispatched. */
async function removeWorker(short: string): Promise<void> {
  const proc = Bun.spawn(['claude', 'rm', short], { stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
}

const spawned: ChildProcess[] = []
const dispatchedShorts: string[] = []
const tempDirs: string[] = []

beforeAll(() => {
  // nothing -- temp cwds are created per test
})

afterEach(() => {
  cleanup()
})

afterAll(async () => {
  for (const p of spawned) {
    try {
      p.kill()
    } catch {}
  }
  for (const short of dispatchedShorts) await removeWorker(short)
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

run('daemon-host e2e', () => {
  it('NEW mode: attaches to a daemon worker and mirrors its transcript to the broker', async () => {
    const dashboard = await connectDashboard()
    await waitForMessage(dashboard, 'conversations_list')
    const conversationId = testId('dm-conv')

    // Play the sentinel's NEW-mode dispatch: claude --bg -> capture short.
    const cwd = mkdtempSync(join(tmpdir(), 'daemon-e2e-'))
    tempDirs.push(cwd)
    const short = await dispatchWorker(cwd, `cw-e2e-${conversationId.slice(-8)}`)
    dispatchedShorts.push(short)

    // Spawn the real daemon-host binary with the env the sentinel would set.
    // Strip RCLAUDE_*/CLAUDWERK_* from the test process env so a developer's
    // interactive session settings do not bleed into the spawned host.
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue
      if (k.startsWith('RCLAUDE_') || k.startsWith('CLAUDWERK_') || k === 'CLAUDECODE') continue
      childEnv[k] = v
    }
    Object.assign(childEnv, {
      RCLAUDE_BROKER: `ws://${process.env.STAGING_BROKER_URL}`,
      RCLAUDE_SECRET: getBrokerSecret(),
      RCLAUDE_CONVERSATION_ID: conversationId,
      CLAUDWERK_DAEMON_SHORT: short,
      RCLAUDE_CWD: cwd,
      DAEMON_HOST_DEBUG: '1',
    })
    const proc = nodeSpawn(DAEMON_BIN, { cwd, stdio: 'inherit', env: childEnv })
    spawned.push(proc)

    // The broker registers the conversation once agent_host_boot lands.
    await waitForMatch(
      dashboard,
      'conversation_update',
      m => (m as { conversation?: { id?: string } }).conversation?.id === conversationId,
      20_000,
    )

    // Subscribe to the transcript channel before the worker turn lands.
    dashboard.send({ type: 'channel_subscribe', channel: 'conversation:transcript', conversationId })
    await waitForMessage(dashboard, 'channel_ack')

    // The worker was dispatched WITH a prompt -- it runs that turn on its own.
    // The daemon-host attaches and mirrors the worker transcript JSONL; the
    // assistant reply must reach the broker as a transcript_entries broadcast.
    const assistantMsg = await waitForMatch(
      dashboard,
      'transcript_entries',
      m => {
        const entries = (m as { entries?: Array<{ type?: string; message?: { content?: unknown } }> }).entries
        if (!entries) return false
        return entries.some(e => {
          if (e.type !== 'assistant') return false
          const content = e.message?.content
          const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
          return text.includes('PROBE-DAEMON-OK')
        })
      },
      120_000,
    )
    expect(assistantMsg).toBeTruthy()

    // /diag confirms agentHostType 'daemon' + the ccSessionId the session
    // observer derived from the daemon `list` op (proves the attach/boot path).
    await sleep(300)
    const diagRes = await httpGet(`/conversations/${conversationId}/diag`, { bearer: getBrokerSecret() })
    expect(diagRes.status).toBe(200)
    const diag = (await diagRes.json()) as {
      id: string
      agentHostType?: string
      agentHostMeta?: Record<string, unknown>
      project?: string
    }
    expect(diag.agentHostType).toBe('daemon')
    expect(diag.project).toMatch(/^daemon:\/\//)
    // The worker's daemon sessionId is observed via `list` and stored as the
    // ccSessionId in the opaque agentHostMeta bag.
    expect(typeof diag.agentHostMeta?.ccSessionId).toBe('string')

    try {
      proc.kill()
    } catch {}
  }, 150_000)
})
