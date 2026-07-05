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
import { parseFrontmatter, serializeFrontmatter } from '../../../shared/frontmatter'
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
export function gateTransition(t: GateTransition): GateOutcome {
  let raw = ''
  try {
    raw = readFileSync(t.cardPath, 'utf-8')
  } catch {
    /* card vanished between find + gate -- meta stays empty, gate resolves off/default */
  }
  const { meta, body } = parseFrontmatter(raw)
  const mode = resolveGateMode(meta, readProjectGateMode(t.dialogCwd))
  const outcome = evaluateGate(
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
    try {
      writeFileSync(t.cardPath, serializeFrontmatter({ ...meta, ...outcome.evidence }, body), 'utf-8')
    } catch {
      /* best-effort evidence stamp -- the move still proceeds */
    }
  }
  return outcome
}
