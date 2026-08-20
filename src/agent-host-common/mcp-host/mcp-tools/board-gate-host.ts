/**
 * Agent-host wiring for the deterministic DONE-gate (board-gate.ts).
 *
 * The pure gate logic lives in `src/shared/board-gate.ts`; this module supplies
 * the SIDE EFFECTS it can't own: real git against the dialog cwd (spawnSync -- a
 * git plumbing call is milliseconds), the bounded test-command runner (async, and
 * it has to stay that way -- see `cmdRunner`), the per-project gate-mode config
 * file, and the machine-authored evidence write-back into the card's frontmatter.
 *
 * Runs on the AGENT HOST, which owns the cwd + git -- the broker never touches
 * the filesystem (boundary covenant).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CmdResult,
  evaluateGate,
  type GateMode,
  type GateOutcome,
  type GitResult,
  isGateMode,
  resolveGateMode,
} from '../../../shared/board-gate'
import { parseFrontmatter } from '../../../shared/frontmatter'
import { serializeCard } from '../../../shared/project-card-file'
import type { TaskStatus } from '../../../shared/task-statuses'

function decode(buf: Uint8Array | null | undefined): string {
  return buf ? new TextDecoder().decode(buf) : ''
}

/** One `git -C cwd <args>`. Never throws -- a structured result on any failure. */
function gitRunner(cwd: string) {
  return (args: string[]): GitResult => {
    try {
      const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
      return { exitCode: p.exitCode ?? -1, stdout: decode(p.stdout), stderr: decode(p.stderr).trim() }
    } catch (err) {
      return { exitCode: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  }
}

/** Grace after the deadline before escalating SIGTERM -> SIGKILL, and the cap on
 *  waiting for pipes a dead shell's orphaned grandchild may still hold open. */
const KILL_GRACE_MS = 5_000

function afterMs<T>(ms: number, value: T): Promise<T> {
  return new Promise(resolve => {
    setTimeout(() => resolve(value), ms).unref?.()
  })
}

const readAll = (s: ReadableStream<Uint8Array> | null): Promise<string> =>
  s ? new Response(s).text() : Promise.resolve('')

/**
 * Bounded `sh -c <cmd>` in the dialog cwd. Combined stdout+stderr; timeout kills.
 *
 * ASYNCHRONOUS ON PURPOSE. This used to be `Bun.spawnSync`, which froze the whole
 * MCP host for the duration: a card whose `test_cmd` is a full suite (this repo's
 * convention, ~3 min) meant the conversation could not service a single other tool
 * call until the suite exited, up to `DEFAULT_TEST_TIMEOUT_MS` (10 min). `Bun.spawn`
 * + await yields the event loop, so the host keeps answering while the suite runs.
 */
export function cmdRunner(cwd: string) {
  return async (cmd: string, timeoutMs: number): Promise<CmdResult> => {
    try {
      const p = Bun.spawn(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })

      // Drain both pipes CONCURRENTLY and start before awaiting the exit: a full
      // pipe buffer with nobody reading it wedges the child forever.
      const drained = Promise.all([readAll(p.stdout), readAll(p.stderr)]).catch(() => ['', ''] as string[])

      // Bun SIGTERMs at the deadline; a child that ignores SIGTERM would leave
      // `exited` pending forever, which is the freeze this rewrite exists to kill.
      const exitedInTime = await Promise.race([p.exited.then(() => true), afterMs(timeoutMs + KILL_GRACE_MS, false)])
      if (!exitedInTime) {
        try {
          p.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }

      // An orphaned grandchild can hold the pipes open after the shell dies --
      // take what drained rather than waiting on a process nobody owns.
      const [out = '', err = ''] = await Promise.race([drained, afterMs(KILL_GRACE_MS, ['', ''] as string[])])
      return {
        exitCode: p.exitCode ?? -1,
        output: out + err,
        timedOut: !exitedInTime || Boolean(p.signalCode),
      }
    } catch (err) {
      return { exitCode: -1, output: err instanceof Error ? err.message : String(err), timedOut: false }
    }
  }
}

/** Read the per-project gate mode from `.rclaude/project/gate.conf` (first token). */
function readProjectGateMode(dialogCwd: string): GateMode | undefined {
  try {
    const raw = readFileSync(join(dialogCwd, '.rclaude', 'project', 'gate.conf'), 'utf-8')
    const token = raw.split('\n')[0]?.trim().toLowerCase()
    return isGateMode(token) ? token : undefined
  } catch {
    return undefined
  }
}

export interface GateTransition {
  dialogCwd: string
  /** Absolute path to the card file at its current (from) status. */
  cardPath: string
  fromStatus: TaskStatus
  targetStatus: TaskStatus
  actingConversationId: string
  nowMs: number
}

/**
 * Evaluate the gate for a set_status transition and, on `allow`, write the
 * machine-authored evidence back into the card's frontmatter (preserving all
 * existing keys + body). Returns the outcome for the caller to log + surface.
 */
export async function gateTransition(t: GateTransition): Promise<GateOutcome> {
  let raw = ''
  try {
    raw = readFileSync(t.cardPath, 'utf-8')
  } catch {
    /* card vanished between find + gate -- meta stays empty, gate resolves off/default */
  }
  const { meta, body } = parseFrontmatter(raw)
  const mode = resolveGateMode(meta, readProjectGateMode(t.dialogCwd))
  const outcome = await evaluateGate(
    {
      fromStatus: t.fromStatus,
      targetStatus: t.targetStatus,
      meta,
      actingConversationId: t.actingConversationId,
      git: gitRunner(t.dialogCwd),
      runCmd: cmdRunner(t.dialogCwd),
      nowMs: t.nowMs,
    },
    mode,
  )

  if (outcome.decision === 'allow' && Object.keys(outcome.evidence).length > 0) {
    writeGateEvidence(t.cardPath, meta, body, outcome.evidence)
  }
  return outcome
}

/**
 * Stamp the gate's machine-authored evidence into the card.
 *
 * Goes through `serializeCard` -- the board's ONE card writer -- and never bare
 * `serializeFrontmatter`. Writing frontmatter directly here made the gate the
 * board's SECOND card writer, and the two disagreed: `serializeCard` collapses
 * linkage ALIASES onto their stored key (`blocked_by:` -> `depends_on:`,
 * `see_also:` -> `relates_to:`) and holds ORDERED_KEYS. A gate stamp used to
 * leave `blocked_by:` sitting next to the `depends_on:` it is supposed to BE --
 * one fact, two spellings, which is the exact thing the closed linkage
 * vocabulary exists to prevent.
 *
 * Takes the meta the gate actually EVALUATED rather than re-reading the file,
 * so a concurrent edit cannot make the stamp describe state that was never
 * checked. Best-effort: a card that cannot be written must not block a move the
 * gate has already allowed.
 */
export function writeGateEvidence(
  cardPath: string,
  meta: Record<string, unknown>,
  body: string,
  evidence: Record<string, unknown>,
): void {
  try {
    writeFileSync(cardPath, serializeCard({ ...meta, ...evidence }, body), 'utf-8')
  } catch {
    /* the move still proceeds */
  }
}
