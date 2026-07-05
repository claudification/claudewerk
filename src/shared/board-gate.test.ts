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
}

function makeGit(o: FakeGitOpts): GitRunner {
  const routes: Array<[string, () => GitResult]> = [
    ['rev-parse --abbrev-ref', () => ok(o.branch ?? 'feat/x')],
    ['rev-parse --verify', () => (o.baseExists === false ? fail() : ok('abc123'))],
    ['status --porcelain', () => ok((o.dirty ?? []).join('\n'))],
    ['rev-list --count', () => ok(String(o.commits ?? 3))],
    ['diff --shortstat', () => ok(o.diffstat ?? ' 2 files changed, 10 insertions(+)')],
  ]
  return (args: string[]): GitResult => {
    const key = args.join(' ')
    return routes.find(([p]) => key.startsWith(p))?.[1]() ?? ok('')
  }
}

const passTest: CmdRunner = () => ({ exitCode: 0, output: 'ok', timedOut: false })
const failTest: CmdRunner = () => ({ exitCode: 1, output: 'AssertionError: boom', timedOut: false })
const timeoutTest: CmdRunner = () => ({ exitCode: -1, output: 'hung', timedOut: true })

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
  it('off mode -> skip, no checks run', () => {
    const out = evaluateGate(input(), 'off')
    expect(out.decision).toBe('skip')
    expect(out.checks).toHaveLength(0)
  })
  it('non-gated target (open) -> skip even under full', () => {
    const out = evaluateGate(input({ targetStatus: 'open' }), 'full')
    expect(out.decision).toBe('skip')
  })
})

describe('evaluateGate — Tier-2 truth table', () => {
  it('clean + committed + diff + no test_cmd -> allow, evidence captured', () => {
    const out = evaluateGate(input({ git: makeGit({ branch: 'feat/x' }) }), 'tier2')
    expect(out.decision).toBe('allow')
    expect(out.evidence.evidence_branch).toBe('feat/x')
    expect(out.evidence.evidence_commits).toBe(3)
    expect(out.evidence.evidence_tests).toBe('none')
    expect(out.evidence.verdict).toBeUndefined() // tier2 never demands a verdict
  })

  it('dirty tree -> refuse with precise reason', () => {
    const out = evaluateGate(input({ git: makeGit({ dirty: [' M a.ts', '?? b.ts'] }) }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('tree dirty: 2 changed files')
  })

  it('no commits since base -> refuse', () => {
    const out = evaluateGate(input({ git: makeGit({ commits: 0 }) }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('no commits since main')
  })

  it('zero diff vs base -> refuse', () => {
    const out = evaluateGate(input({ git: makeGit({ diffstat: '' }) }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('zero diff vs main')
  })

  it('missing base ref -> refuse loudly', () => {
    const out = evaluateGate(input({ git: makeGit({ baseExists: false }) }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain("base ref 'main' not found")
  })

  it('failing test_cmd -> refuse, tests=fail captured', () => {
    const out = evaluateGate(input({ meta: { test_cmd: 'bun test' }, runCmd: failTest }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('test_cmd exit 1')
    expect(out.evidence.evidence_tests).toBe('fail')
  })

  it('timed-out test_cmd -> refuse', () => {
    const out = evaluateGate(input({ meta: { test_cmd: 'sleep 999' }, runCmd: timeoutTest }), 'tier2')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('timed out')
  })

  it('passing test_cmd -> allow, tests=pass', () => {
    const out = evaluateGate(input({ meta: { test_cmd: 'bun test' }, runCmd: passTest }), 'tier2')
    expect(out.decision).toBe('allow')
    expect(out.evidence.evidence_tests).toBe('pass')
  })

  it('respects a custom base field', () => {
    const out = evaluateGate(input({ meta: { base: 'develop' } }), 'tier2')
    expect(out.decision).toBe('allow')
    expect(out.evidence.evidence_base).toBe('develop')
  })
})

describe('evaluateGate — Tier-1 independent verdict (full)', () => {
  it('in-review capture stamps the acting conversation as the worker', () => {
    const out = evaluateGate(
      input({ fromStatus: 'in-progress', targetStatus: 'in-review', actingConversationId: 'conv_worker' }),
      'full',
    )
    expect(out.decision).toBe('allow')
    expect(out.evidence.evidence_worker).toBe('conv_worker')
  })

  it('preserves the original worker across re-review', () => {
    const out = evaluateGate(
      input({
        targetStatus: 'in-review',
        actingConversationId: 'conv_other',
        meta: { evidence_worker: 'conv_worker' },
      }),
      'full',
    )
    expect(out.evidence.evidence_worker).toBe('conv_worker')
  })

  it('done straight from in-progress under full -> refuse (must pass through in-review)', () => {
    const out = evaluateGate(input({ fromStatus: 'in-progress', targetStatus: 'done' }), 'full')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('in-review before done')
  })

  it('done from in-review with no recorded worker -> refuse', () => {
    const out = evaluateGate(input({ fromStatus: 'in-review', targetStatus: 'done', meta: {} }), 'full')
    expect(out.decision).toBe('refuse')
    expect(out.reason).toContain('no worker recorded')
  })

  it('self-approval (worker == acting) -> refuse', () => {
    const out = evaluateGate(
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

  it('independent approver + clean + green -> allow, verdict stamped', () => {
    const out = evaluateGate(
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

  it('full gate still enforces Tier-2 before the verdict (dirty tree beats a valid approver)', () => {
    const out = evaluateGate(
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
