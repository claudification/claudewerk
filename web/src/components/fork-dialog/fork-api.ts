/**
 * Client for POST /api/fork-cc-session.
 *
 * Fork and spawn are deliberately two steps: fork first so the dialog can show
 * what the fold bought before the user commits to launching. A fork nobody
 * launches leaves a valid, resumable transcript on the host -- wasted disk, not
 * lost work.
 */

import type { ForkPointRequest } from './fork-point'

export interface FoldStats {
  beforeTokens: number
  afterTokens: number
  entriesBefore: number
  entriesAfter: number
  digestedResults: number
  droppedThinking: number
  collapsedReads: number
}

export interface ForkRequest {
  conversationId: string
  digestOverTokens?: number
  tailTokenBudget?: number
  /**
   * Where the fork will be LAUNCHED, when retargeting (e.g. into a worktree).
   * Must be sent at FORK time, not launch time: CC derives its transcript
   * directory from its launch cwd, so the fork has to be written there or
   * `--resume` looks in the wrong directory and finds nothing.
   *
   * The worktree NAME is sent rather than a path -- the sentinel owns the
   * `.claude/worktrees/<name>` convention and resolves it.
   */
  targetWorktree?: string
  targetCwd?: string
  /** Fold one side of a boundary entry instead of the whole session. */
  forkPoint?: ForkPointRequest
}

/** How a requested cut actually landed. `none` = the boundary was not found and
 *  the WHOLE transcript came across, which the user asked not to happen. */
export interface ForkCutResult {
  resolvedBy: 'uuid' | 'timestamp' | 'none'
  keptEntries: number
  droppedEntries: number
}

export type ForkResponse =
  | { ok: true; resumeId: string; stats?: FoldStats; cut?: ForkCutResult }
  | { ok: false; error: string }

export type ForkSummaryResponse = { ok: true; summary: string; seedPrompt: string } | { ok: false; error: string }

/** Mode C. No sentinel round-trip -- the broker summarizes from its own store. */
export async function forkSummary(conversationId: string): Promise<ForkSummaryResponse> {
  try {
    const res = await fetch('/api/fork-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    })
    const data = (await res.json().catch(() => null)) as {
      summary?: string
      seedPrompt?: string
      error?: string
    } | null

    if (!res.ok || !data || data.error) {
      return { ok: false, error: data?.error || `Summary failed (HTTP ${res.status})` }
    }
    if (!data.summary || !data.seedPrompt) return { ok: false, error: 'Summarizer returned nothing' }
    return { ok: true, summary: data.summary, seedPrompt: data.seedPrompt }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function forkCcSession(req: ForkRequest): Promise<ForkResponse> {
  try {
    const res = await fetch('/api/fork-cc-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
    const data = (await res.json().catch(() => null)) as {
      resumeId?: string
      stats?: FoldStats
      cut?: ForkCutResult
      error?: string
    } | null

    if (!res.ok || !data || data.error) {
      return { ok: false, error: data?.error || `Fork failed (HTTP ${res.status})` }
    }
    if (!data.resumeId) return { ok: false, error: 'Fork returned no session to resume' }
    return { ok: true, resumeId: data.resumeId, stats: data.stats, cut: data.cut }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
