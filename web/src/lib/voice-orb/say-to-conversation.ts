/**
 * `say_to_conversation` -- the DIRECT path from your mouth to a conversation.
 *
 * Client-local on purpose: "the one I'm looking at" is a fact only the panel
 * knows, and a named target is resolved against the live titles on screen
 * rather than trusting an id out of a speech model. It goes out through the
 * same `sendInput` the text box uses, so it hits the identical broker gate --
 * this is you typing, with your voice.
 *
 * It ALWAYS reports where the message landed, so the orb can say so out loud.
 * An unresolved or ambiguous name sends NOTHING and comes back with candidates.
 */

import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { selectConversations } from '@/lib/slim-conversation'
import { getOrbInstanceId } from './orb-instance'
import { type Candidate, resolveSpokenConversation } from './resolve-conversation'

export interface SayArgs {
  message?: unknown
  target?: unknown
}

/** Live (non-ended) conversations, in the shape the matcher wants. */
export function liveCandidates(): Candidate[] {
  const store = useConversationsStore.getState()
  return selectConversations(store.conversationsById)
    .filter(c => c.status !== 'ended')
    .map(c => ({ conversationId: c.id, title: c.title ?? '', project: c.project ?? '' }))
}

/** The conversation the user is looking at, if it is live. */
function selected(live: Candidate[]): Candidate | undefined {
  const id = useConversationsStore.getState().selectedConversationId
  return id ? live.find(c => c.conversationId === id) : undefined
}

export function runSayToConversation(args: SayArgs): Record<string, unknown> {
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (!message) return { error: 'nothing to send -- ask him what he wants said' }

  const live = liveCandidates()
  const spoken = typeof args.target === 'string' ? args.target.trim() : ''

  if (!spoken) {
    const current = selected(live)
    if (!current) {
      return {
        error: 'no conversation is open on screen -- ask him which one, or open one first',
        candidates: live.slice(0, 5),
      }
    }
    return deliver(current, message)
  }

  const resolved = resolveSpokenConversation(spoken, live)
  if (!resolved.ok) return { error: resolved.error, candidates: resolved.candidates }
  return deliver(resolved.conversation, message)
}

/** Deliver as a real channel message (the send_message rail), not a bare user
 *  turn: the broker stamps `sender="orb"` + `source="rclaude"` +
 *  `from_conversation="orb:<thisBrowser>"`, so it renders "from Orb", the
 *  conversation acts on it as the user's input, and any reply routes back to
 *  THIS orb -- no address the orb has to recite. */
function deliver(target: Candidate, message: string): Record<string, unknown> {
  const ok = wsSend('voice_orb_say', {
    conversationId: target.conversationId,
    message,
    orbId: getOrbInstanceId(),
  })
  if (!ok) return { error: `could not reach "${target.title || target.conversationId}" -- it may have just ended` }
  // The orb reads this back: "posted to X". Never claim a send we did not make.
  return {
    sent: true,
    to: target.title || target.conversationId,
    conversationId: target.conversationId,
    message,
  }
}
