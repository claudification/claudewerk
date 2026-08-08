/**
 * Client for POST /api/fork-cc-session.
 *
 * Fork and spawn are deliberately two steps: fork first so the dialog can show
 * what the fold bought before the user commits to launching. A fork nobody
 * launches leaves a valid, resumable transcript on the host -- wasted disk, not
 * lost work.
 */

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
}

export type ForkResponse = { ok: true; resumeId: string; stats?: FoldStats } | { ok: false; error: string }

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
      error?: string
    } | null

    if (!res.ok || !data || data.error) {
      return { ok: false, error: data?.error || `Fork failed (HTTP ${res.status})` }
    }
    if (!data.resumeId) return { ok: false, error: 'Fork returned no session to resume' }
    return { ok: true, resumeId: data.resumeId, stats: data.stats }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
