/**
 * DONE-GATE deterministic checks (Tier-2 git-state + Tier-1 independent verdict).
 *
 * Pure logic: git and the test command are INJECTED as runners so the truth table
 * is unit-testable with no real repo. Orchestration + config resolution live in
 * `board-gate.ts`; the Bun-backed runners + frontmatter write-back live in the
 * tool handler (project-board.ts).
 */

import {
  DEFAULT_SUITE_RULES,
  parseChangedPaths,
  runDerivedSuites,
  type SuiteRule,
  suiteEntry,
} from './board-gate-suites'
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
/**
 * ASYNC BY CONTRACT. The host's implementation shells out to a card's `test_cmd`,
 * which is routinely a full suite -- a synchronous runner froze that conversation's
 * whole MCP host for the duration (up to DEFAULT_TEST_TIMEOUT_MS). Everything that
 * touches this runner is async for that one reason; do not "simplify" it back.
 */
export type CmdRunner = (cmd: string, timeoutMs: number) => Promise<CmdResult>

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
  /**
   * Suite table for DERIVING what the diff owes (board-gate-suites.ts). Injected
   * because only the host can tell which of these scripts the checkout actually
   * has -- a rule whose script is missing from package.json would refuse a card
   * for a suite that does not exist in that project.
   */
  suiteRules?: readonly SuiteRule[]
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

/**
 * MERGE FRESHNESS -- the branch must already CONTAIN the base it is measured
 * against.
 *
 * A suite run in the worker's worktree tests the BRANCH TIP. The gen-10
 * regression on this board was a property of the MERGE and of nothing else: the
 * branch was green against its own base, `main` had meanwhile grown a test that
 * the branch's diff broke, and both halves of the gate said green because
 * nothing ever ran a suite against the two of them together. An independent
 * verifier that green-lights a branch has said nothing about main.
 *
 * Rather than build a speculative merge in a scratch checkout, require the merge
 * to have ALREADY HAPPENED: once `main` is an ancestor of HEAD, the branch tip IS
 * the merge result, so every other check in this file is measuring the thing
 * that will land. The fix is one command and the refusal names it.
 */
function baseMergedCheck(g: GitRunner, base: string): GateCheck {
  if (g(['merge-base', '--is-ancestor', base, 'HEAD']).exitCode === 0) {
    return { name: 'base-merged', ok: true, detail: `${base} is contained in HEAD -- the tip is the merge` }
  }
  const behind = Number.parseInt(g(['rev-list', '--count', `HEAD..${base}`]).stdout.trim(), 10) || 0
  return {
    name: 'base-merged',
    ok: false,
    detail:
      `${base} has ${behind || 'unmerged'} commit(s) not in this branch -- a suite run here tests the branch tip, ` +
      `not the merge, and green against a stale base has said nothing about ${base}. ` +
      `Run \`git merge ${base}\` in this worktree, fix what breaks, commit, then retry.`,
  }
}

/** The paths the gate derives suites from: `git diff --name-only base...HEAD`. */
function changedPaths(g: GitRunner, base: string): string[] {
  const r = g(['diff', '--name-only', `${base}...HEAD`])
  return r.exitCode === 0 ? parseChangedPaths(r.stdout) : []
}

function testDetail(r: CmdResult, timeoutMs: number): string {
  if (r.timedOut) return `test_cmd timed out after ${timeoutMs}ms`
  return r.exitCode === 0 ? 'test_cmd exit 0' : `test_cmd exit ${r.exitCode}: ${lastLines(r.output, 200)}`
}

async function testCheck(input: GateInput, ev: Ev): Promise<GateCheck> {
  const testCmd = str(input.meta.test_cmd)
  if (!testCmd) {
    ev.evidence_tests = 'none'
    return { name: 'test_cmd', ok: true, detail: 'no test_cmd on card' }
  }
  const timeoutMs = input.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
  const r = await input.runCmd(testCmd, timeoutMs)
  const passed = r.exitCode === 0 && !r.timedOut
  ev.evidence_tests = passed ? 'pass' : 'fail'
  ev.evidence_tests_tail = lastLines(r.output, 400)
  return { name: 'test_cmd', ok: passed, detail: testDetail(r, timeoutMs) }
}

/** Tier-2: deterministic git-state + test gate. Fails closed, precise reasons. */
export async function runTier2(input: GateInput): Promise<{ ok: boolean; checks: GateCheck[]; evidence: Ev }> {
  const evidence: Ev = {}
  const base = str(input.meta.base) || DEFAULT_BASE
  const g = input.git

  // Base must exist -- an unresolvable base can't gate a diff, so refuse loudly.
  if (!captureBranchBase(g, base, evidence)) {
    const detail = `base ref '${base}' not found -- set a valid 'base' on the card`
    return { ok: false, checks: [{ name: 'base-ref', ok: false, detail }], evidence }
  }

  const testCmd = str(input.meta.test_cmd)
  const checks = [
    cleanTreeCheck(g),
    commitsCheck(g, base, evidence),
    diffCheck(g, base, evidence),
    baseMergedCheck(g, base),
    await testCheck(input, evidence),
  ]
  const entries = [
    testCmd
      ? suiteEntry('test_cmd', testCmd, evidence.evidence_tests === 'pass' ? 'pass' : 'fail')
      : 'test_cmd: (none on card)',
  ]

  // The DERIVED suites are the expensive half -- minutes each. Run them only once
  // the cheap checks agree there is something worth testing; a dirty tree or a
  // stale base is already a refusal and does not need a suite to prove it.
  if (checks.every(c => c.ok)) {
    const suites = await runDerivedSuites({
      changed: changedPaths(g, base),
      rules: input.suiteRules ?? DEFAULT_SUITE_RULES,
      testCmd,
      runCmd: input.runCmd,
      timeoutMs: input.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
    })
    checks.push(...suites.checks)
    entries.push(...suites.entries)
  }
  // Names the commands, so "tests passed" can never imply a suite that never ran.
  evidence.evidence_suites = entries

  const acc = input.meta.acceptance_verified
  if (Array.isArray(acc) && acc.length) evidence.evidence_acceptance_verified = acc.map(String)

  return { ok: checks.every(c => c.ok), checks, evidence }
}

/**
 * The machine-written approval trace, stamped on ANY allowed move to `done`.
 *
 * Deliberately NOT private to Tier-1. Tier-1 is the ENFORCEMENT that the
 * approver is not the worker, and it only runs under `full`; recording WHO
 * approved is cheap, unspoofable and useful in every mode. Making it Tier-1's
 * side effect is why a board running with the gate off -- or at `tier2` -- had
 * `grep '^verdict:' cards/*.md` return zero out of 30, so a `done` card and a
 * card whose werk-verifier spawn died looked identical from the board. A reader tells
 * the two apart by comparing `verdict` against `evidence_worker`: same id means
 * the mode did not prove independence, it only recorded the mover.
 */
export function approvalEvidence(input: GateInput): Record<string, unknown> {
  return {
    verdict: `APPROVED by ${input.actingConversationId}`,
    evidence_verified_at: new Date(input.nowMs).toISOString(),
  }
}

const failedTier1 = (detail: string) => ({ ok: false, check: { name: 'independent-verdict', ok: false, detail } })

/** Tier-1: independent verdict. The worker cannot approve its own card. */
export function runTier1(input: GateInput): { ok: boolean; check: GateCheck } {
  if (input.fromStatus !== 'in-review') {
    return failedTier1(`card must pass through in-review before done (from=${input.fromStatus})`)
  }
  const worker = str(input.meta.evidence_worker)
  if (!worker) {
    return failedTier1('no worker recorded on card (never gated into in-review)')
  }
  if (worker === input.actingConversationId) {
    return failedTier1(
      `self-approval refused: worker ${worker} cannot approve its own card -- a different conversation must move in-review -> done`,
    )
  }
  return {
    ok: true,
    check: {
      name: 'independent-verdict',
      ok: true,
      detail: `approved by ${input.actingConversationId} (!= worker ${worker})`,
    },
  }
}
