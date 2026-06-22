/**
 * Dispatch orchestrator (plan-dispatcher-build.md §5 item 2 + §9.2).
 *
 * Composes the whole decision: roster -> classify -> cost-confirm gate ->
 * execute via the underlying spawn/route/revive handlers -> emit a
 * `dispatch_decision` (broadcast) + audit. EVERY decision is emitted + audited,
 * including `ask` (unsure) and decisions HELD at the cost-confirmation gate.
 *
 * HOT-PATH WORKTREE GUARD: every `new` (spawn) decision is routed through
 * assertWorktreeCorrectSpawn BEFORE the executor runs. The dispatcher automating
 * spawns is exactly where the cwd=main+worktree incident would silently recur,
 * so the guard lives on the live path -- not just in a unit test.
 *
 * Decoupled for testability: the roster source, the LLM, the executor, the
 * emit/audit sinks and the clock are all injected. The integration layer wires
 * the real broker handlers (dispatchSpawn / channelSend / handleChannelRevive)
 * behind `DispatchExecutor`, and swaps `RosterSource` from list_conversations to
 * status-tool's LiveStatus feed when it lands -- a one-line change.
 */

import type { DispatchDecision, DispatchDisposition } from '../../shared/protocol'
import { briefFallback } from './brief'
import { type ChatFn, classifyDispatch, type DispatchRosterEntry } from './classify'
import { requiresConfirmation } from './cost'
import { assertWorktreeCorrectSpawn, computeWorktreeCwd } from './worktree'

/** Swappable candidate source. list_conversations today; LiveStatus later. */
export interface RosterSource {
  list(): Promise<DispatchRosterEntry[]>
}

export interface SpawnExec {
  intent: string
  project?: string
  profile?: string
  /** The cwd handed verbatim to dispatchSpawn -- worktree-correct by construction. */
  cwd: string
  /** The worktree/branch intended, if any (drives the guard). */
  worktreeName?: string | null
}
export interface RouteExec {
  conversationId: string
  intent: string
}
export interface ReviveExec {
  conversationId: string
  intent: string
}

export interface DispatchExecutor {
  spawn(req: SpawnExec): Promise<{ conversationId: string }>
  route(req: RouteExec): Promise<{ conversationId: string }>
  revive(req: ReviveExec): Promise<{ conversationId: string }>
}

/** The dispatcher's input -- the wire DispatchRequest plus spawn-resolution hints. */
export interface DispatchCommand {
  intent: string
  target?: string
  disposition?: DispatchDisposition
  /** Set once the user confirmed an expensive route. */
  confirmedExpensive?: boolean
  // Spawn hints (used when the decision resolves to `new`):
  project?: string
  /** Absolute project root; combined with worktreeName to compute the cwd. */
  projectRoot?: string
  profile?: string
  /** Spawn into this worktree/branch. The cwd is COMPUTED from it. */
  worktreeName?: string | null
  /** Explicit cwd override (used when no worktreeName is given). */
  cwd?: string
}

export interface OrchestrateDeps {
  roster: RosterSource
  chat: ChatFn
  executor: DispatchExecutor
  /** Broadcast sink for the dispatch_decision wire message. */
  emit: (d: DispatchDecision) => void
  /** Durable audit sink (recordDecision in production). */
  audit: (d: DispatchDecision) => void
  now: () => number
  newId: () => string
  traceId: string
  /** Generate the concierge's reply for a `converse` decision (briefing over the
   *  roster + near-memory threads). Optional: absent -> a deterministic fallback. */
  brief?: (input: { intent: string; roster: DispatchRosterEntry[] }) => Promise<string>
  /** The host's default spawn directory (sentinel spawnRoot), used when a `new`
   *  decision carries no project/cwd -- the global-desk "no project picked" case. */
  defaultSpawnRoot?: () => string | undefined
}

export async function orchestrateDispatch(cmd: DispatchCommand, deps: OrchestrateDeps): Promise<DispatchDecision> {
  const roster = await deps.roster.list()
  const result = await classifyDispatch(
    { intent: cmd.intent, target: cmd.target, dispositionHint: cmd.disposition, roster },
    deps.chat,
  )

  const decision: DispatchDecision = {
    type: 'dispatch_decision',
    decisionId: deps.newId(),
    intent: cmd.intent,
    disposition: result.disposition,
    confidence: result.confidence,
    reasoning: result.reasoning,
    executed: false,
    traceId: deps.traceId,
    ts: deps.now(),
  }
  if (result.target !== undefined) decision.target = result.target
  if (result.candidates) decision.candidates = result.candidates
  if (result.cost) decision.cost = result.cost

  // Unsure -> surface the candidate cards, do not execute.
  if (result.disposition === 'ask') return record(decision, deps)

  // Conversational / status intent -> the concierge ANSWERS; nothing is spawned
  // or routed. This is the front desk's "just talk to me" path.
  if (result.disposition === 'converse') {
    decision.reply = deps.brief ? await deps.brief({ intent: cmd.intent, roster }) : briefFallback(roster)
    return record(decision, deps)
  }

  // Cost-confirmation gate: hold a very-expensive route until confirmed.
  if (requiresConfirmation(result.cost) && !cmd.confirmedExpensive) {
    decision.awaitingConfirmation = true
    return record(decision, deps)
  }

  try {
    const out = await execute(cmd, result.disposition, decision.target, deps)
    decision.executed = true
    decision.resultConversationId = out.conversationId
  } catch (e) {
    // A refusal (incl. the worktree guard) is audited AND surfaced.
    decision.reasoning = `${decision.reasoning} | execution refused: ${(e as Error).message}`
    record(decision, deps)
    throw e
  }

  return record(decision, deps)
}

function record(decision: DispatchDecision, deps: OrchestrateDeps): DispatchDecision {
  deps.audit(decision)
  deps.emit(decision)
  return decision
}

async function execute(
  cmd: DispatchCommand,
  disposition: DispatchDisposition,
  target: string | undefined,
  deps: OrchestrateDeps,
): Promise<{ conversationId: string }> {
  if (disposition === 'new') {
    // The global front desk usually carries no project context, so fall back to
    // the host's default spawn root when the command names neither cwd nor root.
    const spawn = buildSpawnExec(cmd, deps.defaultSpawnRoot?.())
    // HOT PATH: refuse a worktree spawn whose cwd would land in MAIN.
    assertWorktreeCorrectSpawn({ cwd: spawn.cwd, worktreeName: spawn.worktreeName })
    return deps.executor.spawn(spawn)
  }
  if (!target) throw new Error(`${disposition} decision has no target`)
  if (disposition === 'route') return deps.executor.route({ conversationId: target, intent: cmd.intent })
  return deps.executor.revive({ conversationId: target, intent: cmd.intent })
}

/**
 * Resolve a SpawnExec from the command.
 *
 * An EXPLICIT `cwd` flows through verbatim -- so a caller (or a future bug) that
 * passes `cwd = <project root>` alongside a `worktreeName` produces exactly the
 * incident shape, which the hot-path guard in execute() then REFUSES. We fail
 * loud, not silently auto-fix. When no cwd is given but a worktree is named, the
 * worktree-correct cwd is COMPUTED from projectRoot.
 *
 * `fallbackRoot` (the host's default spawn root) is used ONLY for a plain spawn
 * with no cwd/projectRoot/worktree -- the global-desk "start something new with
 * no project picked" case. It never participates in worktree derivation.
 */
export function buildSpawnExec(cmd: DispatchCommand, fallbackRoot?: string): SpawnExec {
  const worktreeName = cmd.worktreeName?.trim() || null
  let cwd: string
  if (cmd.cwd) {
    cwd = cmd.cwd // explicit -> verbatim; the guard validates it against worktreeName
  } else if (worktreeName) {
    if (!cmd.projectRoot) {
      throw new Error(`worktree '${worktreeName}' requested but no projectRoot to derive the cwd from`)
    }
    cwd = computeWorktreeCwd(cmd.projectRoot, worktreeName)
  } else {
    // Global desk: no project context -> the host's default spawn root.
    const root = cmd.projectRoot ?? fallbackRoot
    if (!root) {
      throw new Error('no project or default spawn root to start new work in -- open a project first')
    }
    cwd = root
  }
  const spawn: SpawnExec = { intent: cmd.intent, cwd, worktreeName }
  if (cmd.project !== undefined) spawn.project = cmd.project
  if (cmd.profile !== undefined) spawn.profile = cmd.profile
  return spawn
}
