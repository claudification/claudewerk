/**
 * HOW A ROLE DRAWS -- the one registry, so no surface re-invents the glyph.
 *
 * A `Record<ConversationRole, …>` with a fallback rather than an if-chain or a
 * switch (STRATEGY MAPS OVER CHAINS). The chain this replaces lived in
 * `partition.ts` and branched on three unrelated mechanisms; the same
 * `capabilities.includes('ad-hoc')` string lookup it used was copy-pasted across
 * seven files.
 *
 * PRESENTATION ONLY. Nothing here may be read to decide what an agent MAY DO --
 * see the law at the top of `src/shared/conversation-role.ts`.
 */

import { type ConversationRole, classifyConversationRole } from '@shared/conversation-role'
import { CircleDot, Eye, ShieldCheck, Wrench } from 'lucide-react'
import type { Conversation } from '@/lib/types'

export interface ConversationRolePresentation {
  /** Lucide component -- callers size it themselves, matching BackendIcon. */
  Icon: typeof CircleDot
  /** Uppercase tag on the row. Empty for `normal`: an ordinary conversation
   *  gets no tag, because tagging the default is noise on every single row. */
  label: string
  /** Tailwind text colour for icon + label. */
  tint: string
  /** Long form, for the row's `title` tooltip. */
  description: string
}

const NORMAL: ConversationRolePresentation = {
  Icon: CircleDot,
  label: '',
  tint: 'text-fg-dim',
  description: 'Conversation',
}

/**
 * The registry. WerkMaster reads as authority (amber), werk-worker as work
 * (sky), werk-verifier as judgement (emerald) -- three hues far enough apart to read
 * at a glance in a dense list, which is the whole point of the glyph.
 */
const ROLE_PRESENTATION: Record<ConversationRole, ConversationRolePresentation> = {
  'werk-master': {
    Icon: Eye,
    label: 'WERK-MASTER',
    tint: 'text-amber-400',
    description: 'WerkMaster -- decides what happens next, and the only seat that may ask you anything',
  },
  'werk-worker': {
    Icon: Wrench,
    label: 'IMPL',
    tint: 'text-sky-400',
    description: 'WerkWorker -- does the work on one card, and cannot ask a human',
  },
  'werk-verifier': {
    Icon: ShieldCheck,
    label: 'VERIFY',
    tint: 'text-emerald-400',
    description: 'WerkVerifier -- judges one card, with no shared context from the werk-worker',
  },
  normal: NORMAL,
}

/**
 * Look up a role's presentation.
 *
 * THE FALLBACK IS NOT DEFENSIVE PADDING. A newer broker can ship a role this
 * bundle has never heard of (the panel and the broker deploy independently, and
 * the service worker can serve a bundle older than the broker for a while). A
 * bare index would hand back `undefined` and blow up on `.Icon` -- one unknown
 * string would white-screen the sidebar.
 */
export function rolePresentation(role: ConversationRole | undefined): ConversationRolePresentation {
  return (role && ROLE_PRESENTATION[role]) || NORMAL
}

/** The role of a conversation as the panel sees it. Thin wrapper over the
 *  shared classifier so components never reach into origin tags themselves. */
export function conversationRole(conversation: Conversation): ConversationRole {
  return classifyConversationRole(conversation)
}
