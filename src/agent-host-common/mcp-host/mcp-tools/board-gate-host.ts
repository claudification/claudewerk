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

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CmdResult,
  evaluateGate,
  type GateMode,
  type GateOutcome,
  type GitResult,
  isGatedTarget,
  isGateMode,
  resolveGateMode,
} from '../../../shared/board-gate'
import { type GateCwd, parseWorktreeList, resolveGateCwd } from '../../../shared/board-gate-worktree'
import { parseCardFrontmatter } from '../../../shared/card-frontmatter'
import type { Frontmatter } from '../../../shared/frontmatter'
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
  /** The conversation's cwd -- the PROJECT ROOT, never the worker's worktree. */
  dialogCwd: string
  /** Card id, i.e. the board's primary key. Also names the worker's worktree. */
  cardId: string
  /** Absolute path to the card file at its current (from) status. */
  cardPath: string
  fromStatus: TaskStatus
  targetStatus: TaskStatus
  actingConversationId: string
  nowMs: number
}

export interface GateTransitionResult {
  outcome: GateOutcome
  /** The checkout git + `test_cmd` actually ran in. */
  gitCwd: string
  cwdNote: GateCwd['note']
}

/**
 * Which checkout to measure. `dialogCwd` is the project root for every
 * conversation on the board (see board-gate-worktree.ts), so ask git for the
 * worktree that carries the card id. Realpath the root first: git prints
 * resolved paths, and on macOS a `/var/...` root would never prefix-match the
 * `/private/var/...` git reports.
 */
function gateCwdFor(dialogCwd: string, cardId: string): GateCwd {
  let root = dialogCwd
  try {
    root = realpathSync(dialogCwd)
  } catch {
    /* root unresolvable -- fall through with the literal cwd */
  }
  const list = gitRunner(root)(['worktree', 'list', '--porcelain'])
  return resolveGateCwd(root, cardId, parseWorktreeList(list.stdout))
}

/** A skipped gate must not pay for a `git worktree list` on a 200-worktree repo. */
function skippedCwd(dialogCwd: string): GateCwd {
  return { cwd: dialogCwd, note: 'no-worktree' }
}

/**
 * Evaluate the gate for a set_status transition and, on `allow`, write the
 * machine-authored evidence back into the card's frontmatter (preserving all
 * existing keys + body). Returns the outcome for the caller to log + surface.
 */
export async function gateTransition(t: GateTransition): Promise<GateTransitionResult> {
  let raw = ''
  try {
    raw = readFileSync(t.cardPath, 'utf-8')
  } catch {
    /* card vanished between find + gate -- meta stays empty, gate resolves off/default */
  }
  const card = parseCardFrontmatter(raw)
  const meta = card.meta
  const mode = resolveGateMode(meta, readProjectGateMode(t.dialogCwd))
  const willRun = mode !== 'off' && isGatedTarget(t.targetStatus)
  const { cwd, note } = willRun ? gateCwdFor(t.dialogCwd, t.cardId) : skippedCwd(t.dialogCwd)
  const outcome = await evaluateGate(
    {
      fromStatus: t.fromStatus,
      targetStatus: t.targetStatus,
      meta,
      actingConversationId: t.actingConversationId,
      git: gitRunner(cwd),
      runCmd: cmdRunner(cwd),
      nowMs: t.nowMs,
    },
    mode,
  )

  if (outcome.decision === 'allow' && Object.keys(outcome.evidence).length > 0) {
    writeGateEvidence(t.cardPath, card, outcome.evidence)
  }
  return { outcome, gitCwd: cwd, cwdNote: note }
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
 * Takes the WHOLE parse the gate actually EVALUATED rather than re-reading the
 * file, so a concurrent edit cannot make the stamp describe state that was never
 * checked. Whole, and not `(meta, body)`: the third field is the card's nested
 * blocks, and a signature that let a caller pass two of three would let the gate
 * stamp evidence onto a card while quietly flattening its `promise:` block.
 * Best-effort: a card that cannot be written must not block a move the gate has
 * already allowed.
 */
export function writeGateEvidence(cardPath: string, card: Frontmatter, evidence: Record<string, unknown>): void {
  try {
    writeFileSync(cardPath, serializeCard({ ...card.meta, ...evidence }, card.body, card.raw), 'utf-8')
  } catch {
    /* the move still proceeds */
  }
}
