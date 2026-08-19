/**
 * "Take me to THIS message" -- the one-shot request behind a transcript-search
 * hit, held between the click and the transcript actually being able to honour
 * it.
 *
 * Its own tiny store rather than a field on the conversations store: the jump is
 * consumed by exactly one component, lives for a few hundred ms, and putting it
 * on the big store would wake every list-row subscriber for it.
 *
 * A jump is a REQUEST, not a scroll position. The transcript may have to fetch
 * older pages and widen its window before the target entry exists at all, so
 * the request survives across those renders and clears itself once honoured (or
 * once it is provably unreachable).
 */

import { create } from 'zustand'

export interface TranscriptJump {
  conversationId: string
  /** Transcript-entry seq to land on, from the search hit. */
  seq: number
  /** Bumped per request so clicking the SAME hit twice re-runs the jump rather
   *  than looking like a no-op state write. */
  nonce: number
}

interface JumpState {
  jump: TranscriptJump | null
  requestJump: (conversationId: string, seq: number) => void
  clearJump: () => void
}

let nonce = 0

export const useTranscriptJumpStore = create<JumpState>(set => ({
  jump: null,
  requestJump: (conversationId, seq) => {
    nonce += 1
    console.log(`[jump] request conv=${conversationId.slice(0, 8)} seq=${seq}`)
    set({ jump: { conversationId, seq, nonce } })
  },
  clearJump: () => set({ jump: null }),
}))

export function requestTranscriptJump(conversationId: string, seq: number): void {
  useTranscriptJumpStore.getState().requestJump(conversationId, seq)
}

/** The pending jump for ONE conversation, or null. Subscribing on the resolved
 *  value keeps a jump into conversation A from re-rendering conversation B. */
export function useJumpFor(conversationId: string | undefined): TranscriptJump | null {
  return useTranscriptJumpStore(s => (s.jump && s.jump.conversationId === conversationId ? s.jump : null))
}
