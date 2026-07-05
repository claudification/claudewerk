/**
 * DONE-GATE deterministic checks (Tier-2 git-state + Tier-1 independent verdict).
 *
 * Pure logic: git and the test command are INJECTED as runners so the truth table
 * is unit-testable with no real repo. Orchestration + config resolution live in
 * `board-gate.ts`; the Bun-backed runners + frontmatter write-back live in the
 * tool handler (project-board.ts).
 */

import type { TaskStatus } from './task-statuses'

export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}
export type GitRunner = (args: string[]) => GitResult

export interface CmdResult {
  exitCode: number
  output: string
  timedOut: boolean
}
export type CmdRunner = (cmd: string, timeoutMs: number) => CmdResult

/** One deterministic check + its actionable, agent-facing detail line. */
export interface GateCheck {
  name: string
  ok: boolean
  detail: string
}

export interface GateInput {
  fromStatus: TaskStatus
  targetStatus: TaskStatus
  /** Parsed card frontmatter (flat scalars + inline arrays -- see frontmatter.ts). */
  meta: Record<string, unknown>
  /** The conversation calling set_status, from ctx.getIdentity() -- unspoofable. */
  actingConversationId: string
  git: GitRunner
  runCmd: CmdRunner
  nowMs: number
  testTimeoutMs?: number
}

const DEFAULT_BASE = 'main'
const DEFAULT_TEST_TIMEOUT_MS = 10 * 60_000

export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function lastLines(text: string, maxChars: number): string {
  const t = text.trimEnd()
  return t.length <= maxChars ? t : `…${t.slice(t.length - maxChars)}`
}

type Ev = Record<string, unknown>

/** Capture branch/base into evidence; return whether the base ref resolves. */
function captureBranchBase(g: GitRunner, base: string, ev: Ev): boolean {
  const branchR = g(['rev-parse', '--abbrev-ref', 'HEAD'])
  ev.evidence_branch = branchR.exitCode === 0 ? branchR.stdout.trim() : '(unknown)'
  ev.evidence_base = base
  return g(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).exitCode === 0
}

function cleanTreeCheck(g: GitRunner): GateCheck {
  const status = g(['status', '--porcelain'])
  const dirty = status.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  return {
    name: 'clean-tree',
    ok: status.exitCode === 0 && dirty.length === 0,
    detail: dirty.length ? `tree dirty: ${dirty.length} changed files` : 'working tree clean',
  }
}

function commitsCheck(g: GitRunner, base: string, ev: Ev): GateCheck {
  const countR = g(['rev-list', '--count', `${base}..HEAD`])
  const commits = countR.exitCode === 0 ? Number.parseInt(countR.stdout.trim(), 10) || 0 : 0
  ev.evidence_commits = commits
  return {
    name: 'commits',
    ok: commits > 0,
    detail: commits > 0 ? `${commits} commit(s) since ${base}` : `no commits since ${base}`,
  }
}

function diffCheck(g: GitRunner, base: string, ev: Ev): GateCheck {
  const diffstat = g(['diff', '--shortstat', `${base}...HEAD`]).stdout.trim()
  ev.evidence_diffstat = diffstat || '0 files'
  return { name: 'diffstat', ok: diffstat.length > 0, detail: diffstat.length > 0 ? diffstat : `zero diff vs ${base}` }
}

function testDetail(r: CmdResult, timeoutMs: number): string {
  if (r.timedOut) return `test_cmd timed out after ${timeoutMs}ms`
  return r.exitCode === 0 ? 'test_cmd exit 0' : `test_cmd exit ${r.exitCode}: ${lastLines(r.output, 200)}`
}

function testCheck(input: GateInput, ev: Ev): GateCheck {
  const testCmd = str(input.meta.test_cmd)
  if (!testCmd) {
    ev.evidence_tests = 'none'
    return { name: 'test_cmd', ok: true, detail: 'no test_cmd on card' }
  }
  const timeoutMs = input.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
  const r = input.runCmd(testCmd, timeoutMs)
  const passed = r.exitCode === 0 && !r.timedOut
  ev.evidence_tests = passed ? 'pass' : 'fail'
  ev.evidence_tests_tail = lastLines(r.output, 400)
  return { name: 'test_cmd', ok: passed, detail: testDetail(r, timeoutMs) }
}

/** Tier-2: deterministic git-state + test gate. Fails closed, precise reasons. */
export function runTier2(input: GateInput): { ok: boolean; checks: GateCheck[]; evidence: Ev } {
  const evidence: Ev = {}
  const base = str(input.meta.base) || DEFAULT_BASE
  const g = input.git

  // Base must exist -- an unresolvable base can't gate a diff, so refuse loudly.
  if (!captureBranchBase(g, base, evidence)) {
    const detail = `base ref '${base}' not found -- set a valid 'base' on the card`
    return { ok: false, checks: [{ name: 'base-ref', ok: false, detail }], evidence }
  }

  const checks = [
    cleanTreeCheck(g),
    commitsCheck(g, base, evidence),
    diffCheck(g, base, evidence),
    testCheck(input, evidence),
  ]

  const acc = input.meta.acceptance_verified
  if (Array.isArray(acc) && acc.length) evidence.evidence_acceptance_verified = acc.map(String)

  return { ok: checks.every(c => c.ok), checks, evidence }
}

/** Tier-1: independent verdict. The worker cannot approve its own card. */
export function runTier1(input: GateInput): { ok: boolean; check: GateCheck; evidence: Record<string, unknown> } {
  if (input.fromStatus !== 'in-review') {
    return {
      ok: false,
      check: {
        name: 'independent-verdict',
        ok: false,
        detail: `card must pass through in-review before done (from=${input.fromStatus})`,
      },
      evidence: {},
    }
  }
  const worker = str(input.meta.evidence_worker)
  if (!worker) {
    return {
      ok: false,
      check: {
        name: 'independent-verdict',
        ok: false,
        detail: 'no worker recorded on card (never gated into in-review)',
      },
      evidence: {},
    }
  }
  if (worker === input.actingConversationId) {
    return {
      ok: false,
      check: {
        name: 'independent-verdict',
        ok: false,
        detail: `self-approval refused: worker ${worker} cannot approve its own card -- a different conversation must move in-review -> done`,
      },
      evidence: {},
    }
  }
  return {
    ok: true,
    check: {
      name: 'independent-verdict',
      ok: true,
      detail: `approved by ${input.actingConversationId} (!= worker ${worker})`,
    },
    evidence: {
      verdict: `APPROVED by ${input.actingConversationId}`,
      evidence_verified_at: new Date(input.nowMs).toISOString(),
    },
  }
}
