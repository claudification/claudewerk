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
import { selectConversations } from '@/lib/slim-conversation'

export interface ControlScreenArgs {
  action?: unknown
  target?: unknown
}

interface Candidate {
  conversationId: string
  title: string
  project: string
}

/** Modal names the orb may open, mapped to the opener that reveals them. */
const OPENABLE: Record<string, () => void> = {
  dispatcher: () =>
    import('@/components/dispatch-overlay/dispatch-store').then(m => m.useDispatchStore.getState().openOverlay()),
}

function liveCandidates(): Candidate[] {
  const store = useConversationsStore.getState()
  return selectConversations(store.conversationsById)
    .filter(c => c.status !== 'ended')
    .map(c => ({ conversationId: c.id, title: c.title ?? '', project: c.project ?? '' }))
}

/** Rank a conversation against a spoken target. 0 = no match. */
function score(c: Candidate, needle: string): number {
  if (c.conversationId === needle) return 100
  const title = c.title.toLowerCase()
  const project = c.project.toLowerCase()
  if (title === needle) return 90
  if (title.includes(needle)) return 70
  if (project.includes(needle)) return 50
  // Spoken titles lose punctuation ("transcript perf" vs "transcript-perf").
  const loose = needle.replace(/[\s-_]+/g, '')
  if (title.replace(/[\s-_]+/g, '').includes(loose)) return 60
  return 0
}

function navigate(rawTarget: string): Record<string, unknown> {
  const needle = rawTarget.trim().toLowerCase()
  if (!needle) return { error: 'navigate needs a conversation id, title, or project' }

  const ranked = liveCandidates()
    .map(c => ({ c, s: score(c, needle) }))
    .filter(r => r.s > 0)
    .sort((a, b) => b.s - a.s)

  const best = ranked[0]
  if (!best) {
    return {
      error: `nothing live matches "${rawTarget}"`,
      candidates: liveCandidates().slice(0, 5),
    }
  }
  const tie = ranked[1]
  if (tie && tie.s === best.s) {
    return { error: `"${rawTarget}" is ambiguous -- ask which one`, candidates: ranked.slice(0, 4).map(r => r.c) }
  }
  useConversationsStore.getState().selectConversation(best.c.conversationId, 'voice-orb')
  return { navigated: best.c }
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
