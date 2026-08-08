/**
 * Run a fork and wait for the sentinel's answer.
 *
 * Extracted from the /api/fork-cc-session route so the SPAWN path can fork too
 * (`SpawnRequest.forkFrom`), which is what lets an agent fork a conversation in
 * one MCP call instead of a client-side two-step.
 */

import { randomUUID } from 'node:crypto'
import type { Conversation, ForkCcSessionResult } from '../shared/protocol'
import { buildForkMessage, type ForkOverrides } from './build-fork'
import type { ConversationStore } from './conversation-store'

/** Folding a multi-MB transcript is real work; well clear of the 5s used for listing. */
export const FORK_TIMEOUT_MS = 60_000

export type RunForkResult =
  | { ok: true; resumeId: string; stats?: ForkCcSessionResult['stats'] }
  | { ok: false; error: string; status: 400 | 409 | 503 | 504 }

export async function runFork(
  conversationStore: ConversationStore,
  conversation: Conversation,
  overrides: ForkOverrides,
): Promise<RunForkResult> {
  // Fork on the conversation's OWN sentinel: the transcript lives on that host,
  // under that host's profile config dir.
  const alias = conversation.hostSentinelAlias
  const sentinel = alias ? conversationStore.getSentinelByAlias(alias) : conversationStore.getSentinel()
  if (!sentinel) {
    return {
      ok: false,
      status: 503,
      error: alias ? `Sentinel "${alias}" not connected` : 'No sentinel connected',
    }
  }

  const requestId = randomUUID()
  const forkMsg = buildForkMessage(conversation, requestId, overrides)
  if (!forkMsg) {
    return { ok: false, status: 409, error: 'This conversation has no Claude Code session to fork yet' }
  }

  let result: ForkCcSessionResult
  try {
    result = await new Promise<ForkCcSessionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        conversationStore.removeForkListener(requestId)
        reject(new Error(`Fork timed out (${FORK_TIMEOUT_MS / 1000}s)`))
      }, FORK_TIMEOUT_MS)

      conversationStore.addForkListener(requestId, msg => {
        clearTimeout(timeout)
        resolve(msg as ForkCcSessionResult)
      })

      sentinel.send(JSON.stringify(forkMsg))
    })
  } catch (err) {
    return { ok: false, status: 504, error: err instanceof Error ? err.message : String(err) }
  }

  if (result.error) return { ok: false, status: 400, error: result.error }
  if (!result.resumeId) return { ok: false, status: 400, error: 'Fork returned no session to resume' }
  return { ok: true, resumeId: result.resumeId, stats: result.stats }
}
