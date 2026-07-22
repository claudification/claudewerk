/**
 * The orb OFFERING to answer: when a question the user must answer opens while
 * the orb is live, it reads the question and its options out loud.
 *
 * Pure decision logic, mirroring narration.ts -- the subscription and the
 * speaking live in the host hook. The rules are what stop this being obnoxious:
 *
 *   - ONE question at a time. While the orb is waiting on an answer it does not
 *     stack a second one on top.
 *   - Never over the orb's own sentence, and a floor between prompts. Shorter
 *     than the fleet-narration floor: a blocked agent is worth interrupting for.
 *   - When the announced question DISAPPEARS (the user answered it on screen, or
 *     the agent withdrew it), the attempt is dropped silently. No "never mind".
 */

import type { AnswerableDialog } from './dialog-answerable'

/** Minimum gap between two spoken prompts. */
export const DIALOG_PROMPT_FLOOR_MS = 10_000

/** How many options are worth speaking before it stops being listenable. */
const MAX_SPOKEN_OPTIONS = 6

export interface PromptableDialog extends AnswerableDialog {
  /** The conversation's name, for "X is asking...". */
  conversationTitle?: string
}

export interface DialogPromptDecision {
  /** What to have the orb say, or null to stay quiet. */
  say: string | null
  /** The question now being waited on -- the caller stores this. */
  announced: string | null
  /** Why it stayed quiet. Debug only. */
  reason?: 'nothing-open' | 'waiting' | 'cleared' | 'orb-busy' | 'cooldown'
}

function spokenOptions(dialog: PromptableDialog): string {
  const labels = dialog.options.slice(0, MAX_SPOKEN_OPTIONS).map(o => o.label)
  const extra = dialog.options.length - labels.length
  return extra > 0 ? `${labels.join(', ')} (and ${extra} more)` : labels.join(', ')
}

function line(dialog: PromptableDialog): string {
  const who = dialog.conversationTitle?.trim() || dialog.conversationId.slice(0, 8)
  return (
    `[open question] "${who}" is asking: "${dialog.question}" -- the options are: ${spokenOptions(dialog)}. ` +
    'Put it to him in one short line with the options, then call `answer_dialog` with what he says. ' +
    'Until you do, nothing is answered.'
  )
}

export function decideDialogPrompt(opts: {
  open: PromptableDialog[]
  announcedKey: string | null
  orbState: string
  lastSpokeAt: number
  now: number
  floorMs?: number
}): DialogPromptDecision {
  if (opts.announcedKey) {
    const still = opts.open.some(d => d.key === opts.announcedKey)
    // Still up: keep waiting on it rather than piling a second question on.
    if (still) return { say: null, announced: opts.announcedKey, reason: 'waiting' }
    // Gone -- answered on screen or withdrawn. Drop the attempt, say nothing.
    return { say: null, announced: null, reason: 'cleared' }
  }

  const [next] = opts.open
  if (!next) return { say: null, announced: null, reason: 'nothing-open' }
  if (opts.orbState === 'speaking' || opts.orbState === 'thinking') {
    return { say: null, announced: null, reason: 'orb-busy' }
  }
  const floor = opts.floorMs ?? DIALOG_PROMPT_FLOOR_MS
  if (opts.now - opts.lastSpokeAt < floor) return { say: null, announced: null, reason: 'cooldown' }

  return { say: line(next), announced: next.key }
}
