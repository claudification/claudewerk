/**
 * `answer_dialog` -- the orb answering an open question WITH the user's voice.
 *
 * Client-local, like `say_to_conversation`, and for the same two reasons: what
 * is open on screen is a fact only the panel holds, and the answer must go out
 * through the EXACT path the visual dialog uses -- `respondToAskQuestion` for a
 * native ask, `submitDialog` for a one-shot dialog. Same store action, same
 * wire message, same result the agent would have got from a click, so the modal
 * closes itself and there is no second code path to keep in sync.
 *
 * NOTHING is submitted on a miss, a tie, or an ambiguous target -- the options
 * come back instead and the orb asks again.
 *
 * THE CANCEL RULE, both ways: the store is re-read at call time, and if the orb
 * had read a question out (`dialog-attempt`) that question has to STILL be the
 * one open. Answered on screen meanwhile? The spoken answer is refused, never
 * re-aimed at whatever else happens to be up.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { clearDialogAttempt, getDialogAttempt } from './dialog-attempt'
import type { PromptableDialog } from './dialog-prompt'
import { conversationTitle, openAnswerable } from './dialog-targets'
import { matchSpokenOption } from './match-option'
import { resolveSpokenConversation } from './resolve-conversation'

export interface AnswerArgs {
  answer?: unknown
  target?: unknown
}

type Picked = PromptableDialog | { error: string }

/** Whose question it is, by name. */
function named(d: PromptableDialog): string {
  return d.conversationTitle ?? conversationTitle(d.conversationId)
}

/** How an unanswered question is described back to the model. */
function describe(d: PromptableDialog): Record<string, unknown> {
  return { conversation: named(d), question: d.question, options: d.options.map(o => o.label) }
}

/** The conversation he NAMED -- resolved against the ones actually asking. */
function pickByName(open: PromptableDialog[], spoken: string): Picked {
  const resolved = resolveSpokenConversation(
    spoken,
    open.map(d => ({ conversationId: d.conversationId, title: d.conversationTitle ?? '', project: '' })),
  )
  if (!resolved.ok) return { error: resolved.error }
  const matches = open.filter(d => d.conversationId === resolved.conversation.conversationId)
  if (matches.length > 1) return { error: `"${spoken}" has more than one question open -- ask which` }
  return matches[0] ?? { error: `nothing open on "${spoken}"` }
}

/** Which open question he is answering. Refuses rather than guessing. */
function pickTarget(open: PromptableDialog[], spoken: string): Picked {
  if (spoken) return pickByName(open, spoken)

  // The one the orb actually read out wins -- and if it is gone, so is the answer.
  const attempt = getDialogAttempt()
  if (attempt) {
    const still = open.find(d => d.key === attempt.key)
    return still ?? { error: 'the question you read out was already answered on screen -- nothing sent' }
  }

  if (open.length === 1) return open[0] as PromptableDialog
  const selectedId = useConversationsStore.getState().selectedConversationId
  const onScreen = open.filter(d => d.conversationId === selectedId)
  if (onScreen.length === 1) return onScreen[0] as PromptableDialog
  return { error: 'more than one question is open -- ask him which one he is answering' }
}

/** Hand the chosen option to the very same store action the UI calls. */
function submit(target: PromptableDialog, value: string, label: string): void {
  const store = useConversationsStore.getState()
  if (target.kind === 'ask') {
    store.respondToAskQuestion(target.conversationId, target.key, { [target.fieldId]: label })
  } else {
    store.submitDialog(target.conversationId, target.key, {
      [target.fieldId]: value,
      _action: 'submit',
      _timeout: false,
      _cancelled: false,
    })
  }
  // Answered: the attempt is spent either way.
  clearDialogAttempt(target.key)
}

export function runAnswerDialog(args: AnswerArgs): Record<string, unknown> {
  const spokenAnswer = typeof args.answer === 'string' ? args.answer.trim() : ''
  if (!spokenAnswer) return { error: 'no answer heard -- ask him what he picks' }

  const open = openAnswerable()
  if (open.length === 0) {
    return { error: 'nothing is open that you can answer -- if he sees one on screen, it needs the panel' }
  }

  const picked = pickTarget(open, typeof args.target === 'string' ? args.target.trim() : '')
  if ('error' in picked) return { ...picked, submitted: false, questions: open.map(describe) }

  const match = matchSpokenOption(spokenAnswer, picked.options)
  if (!match.ok) {
    // NOTHING was submitted. Read the options back and let him pick again.
    return { submitted: false, error: match.error, ...describe(picked) }
  }

  submit(picked, match.option.value, match.option.label)
  return {
    answered: true,
    conversation: named(picked),
    conversationId: picked.conversationId,
    question: picked.question,
    choice: match.option.label,
  }
}
