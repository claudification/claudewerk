/**
 * Agent-host wiring for the deterministic DONE-gate (board-gate.ts).
 *
 * The pure gate logic lives in `src/shared/board-gate.ts`; this module supplies
 * the SIDE EFFECTS it can't own: real git via Bun.spawnSync against the dialog
 * cwd, the bounded test-command runner, the per-project gate-mode config file,
 * and the machine-authored evidence write-back into the card's frontmatter.
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

/** Bounded `sh -c <cmd>` in the dialog cwd. Combined stdout+stderr; timeout kills. */
function cmdRunner(cwd: string) {
  return (cmd: string, timeoutMs: number): CmdResult => {
    try {
      const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
      return {
        exitCode: p.exitCode ?? -1,
        output: decode(p.stdout) + decode(p.stderr),
        timedOut: Boolean(p.signalCode),
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
export function gateTransition(t: GateTransition): GateTransitionResult {
  let raw = ''
  try {
    raw = readFileSync(t.cardPath, 'utf-8')
  } catch {
    /* card vanished between find + gate -- meta stays empty, gate resolves off/default */
  }
  const { meta, body } = parseFrontmatter(raw)
  const mode = resolveGateMode(meta, readProjectGateMode(t.dialogCwd))
  const willRun = mode !== 'off' && isGatedTarget(t.targetStatus)
  const { cwd, note } = willRun ? gateCwdFor(t.dialogCwd, t.cardId) : skippedCwd(t.dialogCwd)
  const outcome = evaluateGate(
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
    writeGateEvidence(t.cardPath, meta, body, outcome.evidence)
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
