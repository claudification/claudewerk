/**
 * Resolve `SpawnRequest.forkFrom` into a launchable request.
 *
 * Folding-then-spawning as ONE call is what makes forking reachable from an
 * agent (MCP `spawn` with `fork_from`) instead of a client-only two-step. The
 * caller names a CONVERSATION; this turns that into either a resume of the
 * folded transcript, or -- for `summarized` -- a fresh session seeded with a
 * continuation summary.
 */

import type { Conversation } from '../shared/protocol'
import { DEFAULT_PROFILE_NAME, type SpawnRequest } from '../shared/spawn-schema'
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

/**
 * Mode C: summarize instead of folding.
 *
 * The result is a FRESH session -- nothing to resume, so no profile holds it.
 * The inherited context rides the system prompt rather than `prompt`, so the
 * agent boots aware of the source instead of being handed a turn to execute.
 */
async function resolveSummarized(
  rest: SpawnRequest,
  source: Conversation,
  conversationStore: ConversationStore,
  deps: ResolveForkDeps,
): Promise<ResolveForkResult> {
  const title = source.title || source.agentName || undefined
  const summary = await (deps.summarize ?? generateForkSummary)({
    entries: conversationStore.getTranscriptEntries(source.id),
    conversationTitle: title,
  })
  if (!summary.ok) return { ok: false, statusCode: 400, error: `forkFrom: ${summary.error}` }

  const seed = buildForkSeedPrompt(summary.summary, { conversationId: source.id, title })
  const appendSystemPrompt = rest.appendSystemPrompt ? `${rest.appendSystemPrompt}\n\n${seed}` : seed
  // Summarized starts a FRESH session rather than resuming a fold, but it is
  // still a fork -- its ancestor is the summarized conversation, so it records
  // the same edge the other strategies do.
  return { ok: true, req: { ...rest, appendSystemPrompt, forkedFrom: source.id } }
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

  if (strategy === 'summarized') return resolveSummarized(rest, source, conversationStore, deps)

  // The fold is written under the SOURCE profile's config dir, so the spawn has
  // to run there too -- CC derives its transcript directory from the profile it
  // boots on, and a mismatch makes `--resume` find nothing and start empty.
  // Omitting the profile is not neutral: the sentinel's picker then consults
  // `defaultSelection` and may land anywhere.
  const forkProfile = source.resolvedProfile || DEFAULT_PROFILE_NAME
  if (rest.profile && rest.profile !== forkProfile) {
    return {
      ok: false,
      statusCode: 400,
      error: `forkFrom: profile "${rest.profile}" contradicts the source profile "${forkProfile}" -- a fork can only resume on the profile that holds its transcript`,
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

  // `forkedFrom` is what makes the child's row point at its SOURCE. Without it
  // the lineage falls back to the spawn caller, which for a fork is the wrong
  // conversation (and for a panel-initiated fork is nobody at all).
  return {
    ok: true,
    req: { ...rest, mode: 'resume', resumeId: forked.resumeId, profile: forkProfile, forkedFrom: source.id },
  }
}
