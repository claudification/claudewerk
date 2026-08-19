/**
 * A1's row model -- ONE shape for every kind of thing that is waiting on a human.
 *
 * A permission gate, an AskUserQuestion, a dialog, a plan approval, a channel
 * link, a spawn approval and a self-reported `needs_you` are six different wire
 * protocols with six different answer paths. The pane must not know that: it
 * renders a list, a waiting clock and some buttons. So every source is folded
 * into this one entry, and the ONLY thing that differs between kinds is which
 * store action the button already closed over.
 *
 * THE TIER IS NOT A STYLE. `hard` means the agent is parked inside a tool call
 * that does not return until someone answers -- un-fakeable, and the whole
 * reason this pane exists. `soft` is the agent's own `needs_you`, which is
 * over-reported by design. They never share a list.
 */

import type { DialogResult } from '@shared/dialog-schema'
import type { PulseBand } from '@/lib/pulse/bands'

/** `hard` = blocked inside a tool call. `soft` = the agent says it wants you. */
export type AttentionTier = 'hard' | 'soft'

/** Which protocol is holding this one. Drives the label, never the layout. */
export type AttentionKind = 'permission' | 'ask' | 'dialog' | 'plan' | 'link' | 'spawn' | 'stuck' | 'needs'

/** One button. `run` has already closed over the real answer path -- the row
 *  calls it and knows nothing about permissions, dialogs or the websocket. */
export interface AttentionAction {
  id: string
  label: string
  /** `go` accepts, `stop` refuses, `alt` is the third way (ALWAYS, an option). */
  tone: 'go' | 'stop' | 'alt'
  run: () => void
}

export interface AttentionEntry {
  /** Identity of THIS pending interaction (requestId / toolUseId / dialogId),
   *  never the conversation: one conversation can hold two questions. */
  key: string
  tier: AttentionTier
  /** The pulse band this row came from -- `blocked` or `needs`, nothing else. */
  band: PulseBand
  kind: AttentionKind
  conversationId: string
  /** Display name, already resolved through project settings. */
  project: string
  projectIcon?: string
  projectColor?: string
  title: string
  /** THE QUESTION, in one line. */
  question: string
  /** The payload under the question -- a command, a file path, an option list. */
  detail?: string
  /** When the waiting started. The clock counts UP from here, live. */
  since: number
  /** Why there are no buttons, when there are none. Silence would read as "this
   *  one is fine", which is the opposite of true. */
  hint?: string
  /** `#` axis -- branch / worktree / agent name. */
  tag?: string
  /** `&` axis. */
  host?: string
  /** `:` axis. */
  model?: string
  actions: AttentionAction[]
}

/**
 * The real answer paths, injected rather than imported.
 *
 * Every one of these is the EXACT store action the conversation's own UI calls,
 * so an answer given here is indistinguishable from one given in the transcript
 * -- same wire message, same optimistic clear, no second code path to keep in
 * sync. Injecting them is also what lets the round-trip be tested against a fake
 * instead of a live websocket.
 */
export interface AttentionAnswers {
  respondToPermission: (conversationId: string, requestId: string, behavior: 'allow' | 'deny', rule?: boolean) => void
  allowPermissionAlways: (conversationId: string, requestId: string, toolName: string) => void
  respondToProjectLink: (fromConversation: string, toConversation: string, action: 'approve' | 'block') => void
  respondToAskQuestion: (conversationId: string, toolUseId: string, answers?: Record<string, string>) => void
  submitDialog: (conversationId: string, dialogId: string, result: DialogResult) => void
  respondToSpawnApproval: (
    conversationId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    persist: boolean,
  ) => void
}

/** How many entries the number keys reach. Five is what fits above the fold. */
export const ATTENTION_KEYS = 5

/**
 * Reading order: HARD first, and inside each tier the one that has been rotting
 * LONGEST leads. Same rule `compareInBand` applies to the blocked and needs
 * bands in Pulse -- a queue whose oldest item is at the bottom is a queue that
 * loses things.
 */
export function compareAttention(a: AttentionEntry, b: AttentionEntry): number {
  if (a.tier !== b.tier) return a.tier === 'hard' ? -1 : 1
  return a.since - b.since
}
