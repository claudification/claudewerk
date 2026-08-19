/**
 * Which permission gates currently have an inline card mounted in the transcript.
 *
 * The pinned bottom banner and the inline card answer the same gate, so showing
 * both is noise. The card registers itself while mounted and the banner renders
 * only what the card is NOT covering.
 *
 * Because the transcript is virtualized, "mounted" tracks roughly "near the
 * viewport" -- so scrolling away from the tool call brings the banner back, and
 * it doubles as the jump-to affordance for a gate you can no longer see.
 */

import { create } from 'zustand'

interface InlinePermissionRegistry {
  /** requestIds with a mounted inline card. */
  mounted: string[]
  register: (requestId: string) => void
  unregister: (requestId: string) => void
}

export const useInlinePermissionRegistry = create<InlinePermissionRegistry>(set => ({
  mounted: [],
  register: requestId =>
    set(state => (state.mounted.includes(requestId) ? state : { mounted: [...state.mounted, requestId] })),
  unregister: requestId =>
    set(state =>
      state.mounted.includes(requestId) ? { mounted: state.mounted.filter(id => id !== requestId) } : state,
    ),
}))
