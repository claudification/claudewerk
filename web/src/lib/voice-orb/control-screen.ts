/**
 * `control_screen` -- the orb's one CLIENT-LOCAL action verb: move the panel.
 * The broker's executor is a stub; navigation only means something in the tab
 * the user is looking at, so the tool-bridge answers it here.
 *
 * Navigation is reversible and harmless (the covenant's "just do it" side), so
 * a confident title match is followed without a spoken confirm. An AMBIGUOUS or
 * unmatched target returns candidates instead of guessing -- voice is lossy and
 * silently landing on the wrong conversation is worse than asking.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { resolveSpokenConversation } from './resolve-conversation'
import { liveCandidates } from './say-to-conversation'

export interface ControlScreenArgs {
  action?: unknown
  target?: unknown
}

/** Modal names the orb may open, mapped to the opener that reveals them. */
const OPENABLE: Record<string, () => void> = {
  dispatcher: () =>
    import('@/components/dispatch-overlay/dispatch-store').then(m => m.useDispatchStore.getState().openOverlay()),
}

function navigate(rawTarget: string): Record<string, unknown> {
  const live = liveCandidates()
  // Same matcher as say_to_conversation: "which one did he mean" must not have
  // two answers, or the orb navigates to one and talks to another.
  const resolved = resolveSpokenConversation(rawTarget, live)
  if (!resolved.ok) return { error: resolved.error, candidates: resolved.candidates }
  useConversationsStore.getState().selectConversation(resolved.conversation.conversationId, 'voice-orb')
  return { navigated: resolved.conversation }
}

function openModal(rawTarget: string): Record<string, unknown> {
  const open = OPENABLE[rawTarget.trim().toLowerCase()]
  if (!open) return { error: `no modal called "${rawTarget}"`, openable: Object.keys(OPENABLE) }
  open()
  return { opened: rawTarget }
}

/** Close the most recently opened managed modal (what "close that" means). */
function closeModal(): Record<string, unknown> {
  const { records, close } = useModalManagerStore.getState()
  const top = Object.values(records).sort((a, b) => b.openedAt - a.openedAt)[0]
  if (!top) return { closed: null, note: 'nothing was open' }
  close(top.id)
  return { closed: top.title || top.id }
}

const ACTIONS: Record<string, (target: string) => Record<string, unknown>> = {
  navigate,
  open_modal: openModal,
  close_modal: () => closeModal(),
}

/** The tool-bridge entry point. Never throws -- an error payload is a fact the
 *  orb can speak, an exception is dead air. */
export function runControlScreen(args: ControlScreenArgs): Record<string, unknown> {
  const action = typeof args.action === 'string' ? args.action : ''
  const run = ACTIONS[action]
  if (!run) return { error: `unknown screen action "${action}"`, actions: Object.keys(ACTIONS) }
  const target = typeof args.target === 'string' ? args.target : ''
  return run(target)
}
