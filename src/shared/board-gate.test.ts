import { describe, expect, it } from 'bun:test'
import {
  type CmdRunner,
  evaluateGate,
  type GateInput,
  type GitResult,
  type GitRunner,
  resolveGateMode,
} from './board-gate'

const ok = (stdout: string): GitResult => ({ exitCode: 0, stdout, stderr: '' })
const fail = (): GitResult => ({ exitCode: 1, stdout: '', stderr: '' })

interface FakeGitOpts {
  branch?: string
  baseExists?: boolean
  dirty?: string[]
  commits?: number
  diffstat?: string
  /** `git diff --name-only base...HEAD` -- what the gate derives suites from. */
  changed?: string[]
  /** false = base has moved on and the branch has not merged it (stale tip). */
  baseMerged?: boolean
  behind?: number
}

function makeGit(o: FakeGitOpts): GitRunner {
  const routes: Array<[string, () => GitResult]> = [
    ['rev-parse --abbrev-ref', () => ok(o.branch ?? 'feat/x')],
    ['rev-parse --verify', () => (o.baseExists === false ? fail() : ok('abc123'))],
    ['status --porcelain', () => ok((o.dirty ?? []).join('\n'))],
    ['merge-base --is-ancestor', () => (o.baseMerged === false ? fail() : ok(''))],
    // Ordered before the generic count route: `HEAD..base` is how far BEHIND the
    // branch is, `base..HEAD` is how many commits it added. Same command, opposite
    // question.
    ['rev-list --count HEAD..', () => ok(String(o.behind ?? 0))],
    ['rev-list --count', () => ok(String(o.commits ?? 3))],
    ['diff --shortstat', () => ok(o.diffstat ?? ' 2 files changed, 10 insertions(+)')],
    ['diff --name-only', () => ok((o.changed ?? []).join('\n'))],
  ]
  return (args: string[]): GitResult => {
    const key = args.join(' ')
    return routes.find(([p]) => key.startsWith(p))?.[1]() ?? ok('')
  }
}

const passTest: CmdRunner = async () => ({ exitCode: 0, output: 'ok', timedOut: false })
const failTest: CmdRunner = async () => ({ exitCode: 1, output: 'AssertionError: boom', timedOut: false })
const timeoutTest: CmdRunner = async () => ({ exitCode: -1, output: 'hung', timedOut: true })

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    fromStatus: 'in-progress',
    targetStatus: 'done',
    meta: {},
    actingConversationId: 'conv_guard',
    git: makeGit({}),
    runCmd: passTest,
    nowMs: 0,
    ...over,
  }
}

describe('resolveGateMode', () => {
  it('defaults to off (current behavior) for a plain card', () => {
    expect(resolveGateMode({})).toBe('off')
  })
  it('honors per-project config when no card override', () => {
    expect(resolveGateMode({}, 'tier2')).toBe('tier2')
  })
  it('quest cards default to full, overriding project config', () => {
    expect(resolveGateMode({ quest: 'floppy-panda' }, 'off')).toBe('full')
  })
  it('per-card gate override wins over everything', () => {
    expect(resolveGateMode({ quest: 'floppy-panda', gate: 'tier2' }, 'off')).toBe('tier2')
  })
  it('ignores an invalid gate value and falls through', () => {
    expect(resolveGateMode({ gate: 'bogus' }, 'full')).toBe('full')
  })
})

describe('evaluateGate — mode/target gating', () => {
  it('off mode -> skip, no checks run', async () => {
    const out = await evaluateGate(input(), 'off')
    expect(out.decision).toBe('skip')
    expect(out.checks).toHaveLength(0)
  })
  it('non-gated target (open) -> skip even under full', async () => {
    const out = await evaluateGate(input({ targetStatus: 'open' }), 'full')
    expect(out.decision).toBe('skip')
  })
})

describe('evaluateGate — Tier-2 truth table', () => {
  it('clean + committed + diff + no test_cmd -> allow, evidence captured', async () => {
    const out = await evaluateGate(input({ git: makeGit({ branch: 'feat/x' }) }), 'tier2')
    expect(out.decision).toBe('allow')
    expect(out.evidence.evidence_branch).toBe('feat/x')
    expect(out.evidence.evidence_commits).toBe(3)
    expect(out.evidence.evidence_tests).toBe('none')
  })

  it('an in-review capture is not an approval -- no verdict', async () => {
    const out = await evaluateGate(input({ targetStatus: 'in-review' }), 'tier2')
    expect(out.decision).toBe('allow')
    expect(out.evidence.verdict).toBeUndefined()
  })

  it('dirty tree -> refuse with precise reason', async () => {
    const out = await evaluateGate(input({ git: makeGit({ dirty: [' M a.ts', '?? b.ts'] }) }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('tree dirty: 2 changed files')
  })

  it('no commits since base -> refuse', async () => {
    const out = await evaluateGate(input({ git: makeGit({ commits: 0 }) }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('no commits since main')
  })

  it('zero diff vs base -> refuse', async () => {
    const out = await evaluateGate(input({ git: makeGit({ diffstat: '' }) }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('zero diff vs main')
  })

  it('missing base ref -> refuse loudly', async () => {
    const out = await evaluateGate(input({ git: makeGit({ baseExists: false }) }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain("base ref 'main' not found")
  })

  it('failing test_cmd -> refuse, tests=fail captured', async () => {
    const out = await evaluateGate(input({ meta: { test_cmd: 'bun test' }, runCmd: failTest }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('test_cmd exit 1')
    expect(out.evidence.evidence_tests).toBe('fail')
  })

  it('timed-out test_cmd -> refuse', async () => {
    const out = await evaluateGate(input({ meta: { test_cmd: 'sleep 999' }, runCmd: timeoutTest }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('timed out')
  })

  it('passing test_cmd -> allow, tests=pass', async () => {
    const out = await evaluateGate(input({ meta: { test_cmd: 'bun test' }, runCmd: passTest }), 'tier2')
    expect(out.decision).toBe('allow')
    expect(out.evidence.evidence_tests).toBe('pass')
  })

  it('respects a custom base field', async () => {
    const out = await evaluateGate(input({ meta: { base: 'develop' } }), 'tier2')
    expect(out.decision).toBe('allow')
    expect(out.evidence.evidence_base).toBe('develop')
  })
})

describe('evaluateGate — the gate derives suites from the diff, not from test_cmd', () => {
  /** A runner that answers per command, so a suite can fail while test_cmd passes. */
  const cmdBy =
    (byCmd: Record<string, number>): CmdRunner =>
    async cmd => ({ exitCode: byCmd[cmd] ?? 0, output: `output of ${cmd}`, timedOut: false })

  it('THE GEN-10 REPLAY: a src/shared-only diff with a narrow test_cmd is refused by the web suite', async () => {
    // b9b12b4c: only src/shared/epic-run-caps.ts changed, test_cmd was
    // `bun run test src/broker src/shared && bun run typecheck`, and
    // web/.../run-model.test.ts went red on the merge. Both halves said green.
    const out = await evaluateGate(
      input({
        targetStatus: 'in-review',
        meta: { test_cmd: 'bun run test src/broker src/shared && bun run typecheck' },
        git: makeGit({ changed: ['src/shared/epic-run-caps.ts'] }),
        runCmd: cmdBy({ 'bun run test:web': 1 }),
      }),
      'tier2',
    )
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('bun run test:web exit 1')
    expect(out.reason).toContain('the diff obliges this suite')
  })

  it('the reverse: a web-only diff that breaks the ROOT suite is refused', async () => {
    const out = await evaluateGate(
      input({
        targetStatus: 'in-review',
        meta: { test_cmd: 'cd web && bun run test:run' },
        git: makeGit({ changed: ['web/src/components/wall/werk-master-detail.tsx'] }),
        runCmd: cmdBy({ 'bun run test': 1 }),
      }),
      'tier2',
    )
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('bun run test exit 1')
  })

  it('records every command it ran, so "tests passed" names them', async () => {
    const out = await evaluateGate(
      input({
        targetStatus: 'in-review',
        meta: { test_cmd: 'bun run typecheck' },
        git: makeGit({ changed: ['src/shared/epic-run-caps.ts'] }),
      }),
      'tier2',
    )
    expect(out.decision).toBe('allow')
    expect(out.evidence.evidence_suites).toEqual([
      'test_cmd: bun run typecheck -> pass',
      'root: bun run test -> pass',
      'web: bun run test:web -> pass',
    ])
  })

  it('a card with no test_cmd still owes the suites its diff touched', async () => {
    const out = await evaluateGate(
      input({
        targetStatus: 'in-review',
        git: makeGit({ changed: ['src/broker/epic-ready.ts'] }),
        runCmd: cmdBy({ 'bun run test': 1 }),
      }),
      'tier2',
    )
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('bun run test exit 1')
  })

  it('an empty rule set (project without those scripts) derives nothing and still allows', async () => {
    const out = await evaluateGate(
      input({
        targetStatus: 'in-review',
        git: makeGit({ changed: ['src/shared/x.ts'] }),
        suiteRules: [],
      }),
      'tier2',
    )
    expect(out.decision).toBe('allow')
    expect(out.evidence.evidence_suites).toEqual([
      'test_cmd: (none on card)',
      'derived: (none -- 1 changed path(s) match no suite trigger)',
    ])
  })

  it('a failing test_cmd short-circuits the expensive suites', async () => {
    const seen: string[] = []
    const runCmd: CmdRunner = async cmd => {
      seen.push(cmd)
      return { exitCode: 1, output: 'boom', timedOut: false }
    }
    const out = await evaluateGate(
      input({
        targetStatus: 'in-review',
        meta: { test_cmd: 'bun run typecheck' },
        git: makeGit({ changed: ['src/shared/x.ts'] }),
        runCmd,
      }),
      'tier2',
    )
    expect(out.decision).toBe('refuse')
    expect(seen).toEqual(['bun run typecheck'])
  })
})

describe('evaluateGate — the suite must run against the MERGE, not the branch tip', () => {
  it('base moved on and the branch never merged it -> refuse, naming the command', async () => {
    const out = await evaluateGate(
      input({ targetStatus: 'in-review', git: makeGit({ baseMerged: false, behind: 4 }) }),
      'tier2',
    )
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('main has 4 commit(s) not in this branch')
    expect(out.reason).toContain('git merge main')
  })

  it('a stale base is refused BEFORE any suite runs', async () => {
    const seen: string[] = []
    const runCmd: CmdRunner = async cmd => {
      seen.push(cmd)
      return { exitCode: 0, output: '', timedOut: false }
    }
    await evaluateGate(
      input({
        targetStatus: 'in-review',
        meta: { test_cmd: 'bun run typecheck' },
        git: makeGit({ baseMerged: false, behind: 1, changed: ['src/shared/x.ts'] }),
        runCmd,
      }),
      'tier2',
    )
    expect(seen).toEqual(['bun run typecheck'])
  })

  it('the check honors a custom base', async () => {
    const out = await evaluateGate(
      input({ targetStatus: 'in-review', meta: { base: 'develop' }, git: makeGit({ baseMerged: false, behind: 2 }) }),
      'tier2',
    )
    expect(out.reason).toContain('develop has 2 commit(s) not in this branch')
    expect(out.reason).toContain('git merge develop')
  })

  it('base contained in HEAD -> the tip IS the merge, allow', async () => {
    const out = await evaluateGate(input({ targetStatus: 'in-review', git: makeGit({ baseMerged: true }) }), 'tier2')
    expect(out.decision).toBe('allow')
  })
})

describe('evaluateGate — an approval always leaves a trace', () => {
  it('tier2 RECORDS the verdict on done even though it cannot prove independence', async () => {
    const out = await evaluateGate(input({ targetStatus: 'done', actingConversationId: 'conv_x' }), 'tier2')
    expect(out.decision).toBe('allow')
    expect(out.evidence.verdict).toBe('APPROVED by conv_x')
    expect(out.evidence.evidence_verified_at).toBe('1970-01-01T00:00:00.000Z')
  })

  it('tier2 does NOT enforce independence -- the worker may approve itself, and it shows', async () => {
    const out = await evaluateGate(
      input({
        fromStatus: 'in-review',
        targetStatus: 'done',
        actingConversationId: 'conv_worker',
        meta: { evidence_worker: 'conv_worker' },
      }),
      'tier2',
    )
    expect(out.decision).toBe('allow')
    // Same id on both keys is exactly how a reader spots an unproven approval.
    expect(out.evidence.verdict).toBe('APPROVED by conv_worker')
  })

  it('a refused done stamps no verdict at all', async () => {
    const out = await evaluateGate(input({ targetStatus: 'done', git: makeGit({ dirty: [' M a.ts'] }) }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.evidence.verdict).toBeUndefined()
  })

  it('gate off stamps nothing, verdict included', async () => {
    const out = await evaluateGate(input({ targetStatus: 'done' }), 'off')
    expect(out.evidence).toEqual({})
  })
})

describe('evaluateGate — Tier-1 independent verdict (full)', () => {
  it('in-review capture stamps the acting conversation as the worker', async () => {
    const out = await evaluateGate(
      input({ fromStatus: 'in-progress', targetStatus: 'in-review', actingConversationId: 'conv_worker' }),
      'full',
    )
    expect(out.decision).toBe('allow')
    expect(out.evidence.evidence_worker).toBe('conv_worker')
  })

  it('preserves the original worker across re-review', async () => {
    const out = await evaluateGate(
      input({
        targetStatus: 'in-review',
        actingConversationId: 'conv_other',
        meta: { evidence_worker: 'conv_worker' },
      }),
      'full',
    )
    expect(out.evidence.evidence_worker).toBe('conv_worker')
  })

  it('done straight from in-progress under full -> refuse (must pass through in-review)', async () => {
    const out = await evaluateGate(input({ fromStatus: 'in-progress', targetStatus: 'done' }), 'full')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('in-review before done')
  })

  it('done from in-review with no recorded worker -> refuse', async () => {
    const out = await evaluateGate(input({ fromStatus: 'in-review', targetStatus: 'done', meta: {} }), 'full')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('no worker recorded')
  })

  it('self-approval (worker == acting) -> refuse', async () => {
    const out = await evaluateGate(
      input({
        fromStatus: 'in-review',
        targetStatus: 'done',
        actingConversationId: 'conv_worker',
        meta: { evidence_worker: 'conv_worker' },
      }),
      'full',
    )
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('self-approval refused')
  })

  it('independent approver + clean + green -> allow, verdict stamped', async () => {
    const out = await evaluateGate(
      input({
        fromStatus: 'in-review',
        targetStatus: 'done',
        actingConversationId: 'conv_guard',
        meta: { evidence_worker: 'conv_worker', test_cmd: 'bun test' },
        runCmd: passTest,
      }),
      'full',
    )
    expect(out.decision).toBe('allow')
    expect(out.evidence.verdict).toBe('APPROVED by conv_guard')
    expect(out.evidence.evidence_verified_at).toBe('1970-01-01T00:00:00.000Z')
  })

  it('full gate still enforces Tier-2 before the verdict (dirty tree beats a valid approver)', async () => {
    const out = await evaluateGate(
      input({
        fromStatus: 'in-review',
        targetStatus: 'done',
        actingConversationId: 'conv_guard',
        git: makeGit({ dirty: [' M x.ts'] }),
        meta: { evidence_worker: 'conv_worker' },
      }),
      'full',
    )
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('tree dirty')
    expect(out.evidence.verdict).toBeUndefined()
  })
})
