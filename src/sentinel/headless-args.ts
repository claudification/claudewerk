/**
 * THE ARGV FOR A DIRECTLY-SPAWNED HEADLESS `rclaude`.
 *
 * Lifted out of `index.ts` for one reason: it is the place a CAP becomes a flag,
 * and until `order-caps-turns-and-reservation` there was no way to assert that
 * without booting a sentinel. `REFINER@1` declared `maxTurns: 30` for a whole
 * card's lifetime with nothing downstream reading it, so a cap that reaches no
 * argv is the exact failure this seam now has a test for.
 *
 * WHAT `rclaude` DOES WITH THESE. It parses the handful of flags it owns
 * (`--headless`, `--broker`, ...) and everything else falls through to
 * `claudeArgs` (`src/claude-agent-host/cli-args.ts`), which `stream-backend.ts`
 * forwards verbatim to `claude`. So a flag here is a flag CC sees, and a
 * misspelling is a hard `error: unknown option` at spawn rather than a silent
 * no-op -- which is the failure mode you want for a ceiling.
 *
 * PURE, and deliberately: the interesting cases (what an unattended-guarded mode
 * omits, which caps made it onto the line) are a table, not a process.
 */

export interface HeadlessArgsOpts {
  mode?: 'fresh' | 'resume'
  resumeId?: string
  resumeName?: string
  effort?: string
  model?: string
  agent?: string
  worktree?: string
  maxBudgetUsd?: number
  /** CC `--max-turns`: the hard turn ceiling, usually from an order's `caps.maxTurns`. */
  maxTurns?: number
  permissionMode?: string
}

/** Build CLI args for a directly-spawned headless rclaude process. */
export function buildHeadlessArgs(opts: HeadlessArgsOpts): string[] {
  // Headless has no human to answer a prompt, so the legacy default is full
  // bypass (--dangerously-skip-permissions) -- a spawn must never hang waiting
  // for an approval nobody can give. The two unattended-but-GUARDED modes
  // (auto = managed classifier, dontAsk = allow-list + read-only bash) are the
  // nightshift permission model (plan-nightshift.md §10): for those we must NOT
  // force bypass -- the chosen mode flows through RCLAUDE_PERMISSION_MODE ->
  // cli-args `--permission-mode`, and the deny-floor still bites. Every other
  // value (incl. undefined / plan / acceptEdits / bypassPermissions) keeps the
  // legacy bypass so no existing spawn changes behavior.
  const unattendedGuarded = opts.permissionMode === 'auto' || opts.permissionMode === 'dontAsk'
  const args: string[] = unattendedGuarded ? [] : ['--dangerously-skip-permissions']
  if (opts.mode === 'resume') {
    const resumeKey = opts.resumeId || opts.resumeName
    if (resumeKey) args.push('--resume', resumeKey)
  }
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.model) args.push('--model', opts.model)
  if (opts.agent) args.push('--agent', opts.agent)
  if (opts.worktree) args.push('--worktree', opts.worktree)
  if (opts.maxBudgetUsd) args.push('--max-budget-usd', String(opts.maxBudgetUsd))
  // `--max-turns` is a HIDDEN CC flag (docs/stream-json-protocol.md § flags):
  // absent from `claude --help`, accepted by the parser. Emitted beside the
  // budget because the two are the same kind of promise -- a hard stop on a seat
  // nobody is watching -- and an order narrows both through the same path.
  if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns))
  return args
}
