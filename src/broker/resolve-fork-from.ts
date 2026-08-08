/**
 * Resolve `SpawnRequest.forkFrom` into a launchable request.
 *
 * Folding-then-spawning as ONE call is what makes forking reachable from an
 * agent (MCP `spawn` with `fork_from`) instead of a client-only two-step. The
 * caller names a CONVERSATION; this turns that into either a resume of the
 * folded transcript, or -- for `summarized` -- a fresh session seeded with a
 * continuation summary.
 */

import type { SpawnRequest } from '../shared/spawn-schema'
import type { ConversationStore } from './conversation-store'
import { runFork } from './fork-run'
import { buildForkSeedPrompt, generateForkSummary } from './fork-summary'

export type ResolveForkResult =
  | { ok: true; req: SpawnRequest }
  | { ok: false; error: string; statusCode: 400 | 403 | 404 | 409 | 500 | 503 | 504 }

/** Fold knobs per strategy. Mirrors the dialog's FORK_STRATEGIES. */
const STRATEGY_FOLD: Record<'full' | 'condensed', { digestOverTokens: number; tailTokenBudget?: number }> = {
  // 0 = digest nothing: a faithful copy that still gets a fresh session id.
  full: { digestOverTokens: 0 },
  condensed: { digestOverTokens: 400, tailTokenBudget: 20_000 },
}

export interface ResolveForkDeps {
  /** Injectable so the summarized path is testable without a live model call. */
  summarize?: typeof generateForkSummary
}

export async function resolveForkFrom(
  req: SpawnRequest,
  conversationStore: ConversationStore,
  deps: ResolveForkDeps = {},
): Promise<ResolveForkResult> {
  if (!req.forkFrom) return { ok: true, req }

  const source = conversationStore.getConversation(req.forkFrom)
  if (!source) return { ok: false, statusCode: 404, error: `forkFrom: conversation ${req.forkFrom} not found` }

  // Passing these alongside forkFrom is a contradiction, not something to
  // silently resolve one way -- the caller would get a fork of something other
  // than what they named.
  if (req.resumeId || req.mode === 'resume') {
    return {
      ok: false,
      statusCode: 400,
      error: 'forkFrom cannot be combined with mode/resumeId -- forkFrom sets them itself',
    }
  }

  const strategy = req.forkStrategy ?? 'condensed'
  // Strip the fork fields so they never reach a backend that would not know
  // what to do with them.
  const { forkFrom: _f, forkStrategy: _s, ...rest } = req

  if (strategy === 'summarized') {
    const entries = conversationStore.getTranscriptEntries(req.forkFrom)
    const summary = await (deps.summarize ?? generateForkSummary)({
      entries,
      conversationTitle: source.title || source.agentName || undefined,
    })
    if (!summary.ok) return { ok: false, statusCode: 400, error: `forkFrom: ${summary.error}` }

    const seed = buildForkSeedPrompt(summary.summary, {
      conversationId: source.id,
      title: source.title || source.agentName || undefined,
    })
    // FRESH session -- nothing to resume. The inherited context rides the system
    // prompt so the agent is not handed a turn to execute on boot.
    return {
      ok: true,
      req: {
        ...rest,
        cwd: rest.cwd,
        appendSystemPrompt: rest.appendSystemPrompt ? `${rest.appendSystemPrompt}\n\n${seed}` : seed,
      },
    }
  }

  const fold = STRATEGY_FOLD[strategy]
  const forked = await runFork(conversationStore, source, {
    digestOverTokens: fold.digestOverTokens,
    tailTokenBudget: fold.tailTokenBudget,
    // The fork must land where the spawn will run, or CC's --resume looks in a
    // different transcript directory and silently starts fresh.
    targetWorktree: rest.worktree,
    targetCwd: rest.cwd,
  })
  if (!forked.ok) return { ok: false, statusCode: forked.status, error: `forkFrom: ${forked.error}` }

  return { ok: true, req: { ...rest, mode: 'resume', resumeId: forked.resumeId } }
}
