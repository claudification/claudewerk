/**
 * Shared harness for smokes that need a REAL broker.
 *
 * Every one of these tests is only worth anything because it runs against the
 * actual broker process rather than a mock -- so they all need the same setup:
 * boot a throwaway broker (temp cache dir, non-prod port), wait for health,
 * mint a dev key to authenticate as a user, open sockets, and report.
 *
 * That boilerplate lives here once. NEVER point any of it at the prod broker:
 * the cache dir is a fresh mkdtemp and the port is caller-supplied precisely so
 * a smoke can never touch real data.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SmokeBrokerOptions {
  port: number
  secret: string
  /** Repo root -- the cwd the broker is spawned from. */
  repo: string
  /** Prefix for the throwaway cache dir, for recognizability in /tmp. */
  label: string
  /** Surface the broker's own stdout/stderr. Set from an env flag: it is how
   *  you find out WHY a leg failed, and it is noise the rest of the time. */
  logs?: boolean
}

export interface SmokeBroker {
  base: string
  cacheDir: string
  /** Kill the broker and delete its cache dir. Always call in a `finally`. */
  stop(): void
}

/** Boot a throwaway broker and wait for it to answer /health. */
// Retry loop + two failure exits. The harness that boots test brokers is not
// itself unit-tested, so CRAP is zero-coverage arithmetic, not risk.
// fallow-ignore-next-line complexity
export async function startSmokeBroker(opts: SmokeBrokerOptions): Promise<SmokeBroker> {
  const cacheDir = mkdtempSync(join(tmpdir(), `${opts.label}-`))
  const proc = spawn(
    'bun',
    [
      'run',
      'src/broker/index.ts',
      '--cache-dir',
      cacheDir,
      '--port',
      String(opts.port),
      '--rclaude-secret',
      opts.secret,
    ],
    {
      cwd: opts.repo,
      // VAPID off: an http base URL fails VAPID subject validation.
      env: { ...process.env, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', DEV_HARNESS_ENABLED: '1' },
      stdio: opts.logs ? 'inherit' : 'ignore',
    },
  )
  const base = `http://localhost:${opts.port}`
  const stop = () => {
    proc.kill()
    rmSync(cacheDir, { recursive: true, force: true })
  }
  try {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) return { base, cacheDir, stop }
      } catch {}
      await Bun.sleep(500)
    }
  } catch (err) {
    stop()
    throw err
  }
  stop()
  throw new Error(`broker did not become healthy on ${base}`)
}

/**
 * Mint a dev-harness impersonation key -- the `cw-session` cookie value that
 * authenticates a smoke's socket AS a user (so it gets the control-panel role).
 * CLI-only by design; there is deliberately no HTTP mint route.
 */
export function mintDevKey(repo: string, cacheDir: string, asUser = 'smoke-user'): string {
  const r = Bun.spawnSync(
    ['bun', 'run', 'src/broker/cli.ts', 'mint-dev-key', '--as', asUser, '--cache-dir', cacheDir],
    { cwd: repo, env: { ...process.env, DEV_HARNESS_ENABLED: '1' } },
  )
  const token = (r.stdout.toString() + r.stderr.toString()).match(/dvk_[A-Za-z0-9_\-.]+/)?.[0]
  if (!token) throw new Error(`could not mint a dev key:\n${r.stdout.toString()}${r.stderr.toString()}`)
  return token
}

/** A test socket: every inbound frame, kept, with helpers to query and wait. */
export interface SmokeSocket {
  ws: WebSocket
  frames: Record<string, unknown>[]
  of(type: string): Record<string, unknown>[]
  send(msg: Record<string, unknown>): void
  /** Wait until `pred` holds over the collected frames. False on timeout. */
  until(pred: (frames: Record<string, unknown>[]) => boolean, ms?: number): Promise<boolean>
  /** Forget everything seen so far -- use before asserting that nothing arrives. */
  clear(): void
  close(): void
}

export async function openSmokeSocket(url: string, headers?: Record<string, string>): Promise<SmokeSocket> {
  const ws = new WebSocket(url, headers ? ({ headers } as never) : undefined)
  const frames: Record<string, unknown>[] = []
  ws.addEventListener('message', ev => {
    try {
      frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>)
    } catch {}
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error(`WS connect failed: ${url}`)))
    setTimeout(() => reject(new Error(`WS connect timed out: ${url}`)), 5000)
  })
  return {
    ws,
    frames,
    of: type => frames.filter(f => f.type === type),
    send: msg => ws.send(JSON.stringify(msg)),
    async until(pred, ms = 4000) {
      for (let i = 0; i < ms / 100; i++) {
        if (pred(frames)) return true
        await Bun.sleep(100)
      }
      return false
    },
    clear: () => {
      frames.length = 0
    },
    close: () => ws.close(),
  }
}

/** Collects PASS/FAIL lines and produces the exit code. */
export function createSmokeReport() {
  const results: { name: string; ok: boolean; detail: string }[] = []
  return {
    check(name: string, ok: boolean, detail: string): void {
      results.push({ name, ok, detail })
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
    },
    /** Print the tally and exit non-zero if anything failed. */
    finish(): never {
      const failed = results.filter(r => !r.ok)
      console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
      process.exit(failed.length ? 1 : 0)
    },
  }
}
