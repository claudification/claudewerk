/**
 * Visit-scoped "user loaded older history" latch for the transcript window.
 *
 * Set on the first loadEarlier/fetchOlder of a visit; mirrored into the store
 * (transcriptHeadHeld) so the prune sites back off (lib/transcript-prune.ts);
 * released -- with an over-cap collapse into the page cache -- when the user
 * switches away (cacheKey change or unmount). The local ref serves the window
 * hook's render-phase re-anchor decision without a store subscription.
 *
 * Prior art rationale: ChatGPT/Slack/Discord keep loaded history mounted for
 * the whole visit; collapsing it the instant the reader grazes the bottom
 * visibly destroyed the scrollbar length and the reader's position.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'

export function useTranscriptHeadHold(cacheKey: string | undefined) {
  const headHeldRef = useRef(false)
  const cacheKeyRef = useRef(cacheKey)
  cacheKeyRef.current = cacheKey

  const markHeadHeld = useCallback(() => {
    headHeldRef.current = true
    const cid = cacheKeyRef.current
    if (cid) useConversationsStore.getState().holdTranscriptHead(cid)
  }, [])

  useEffect(() => {
    const cid = cacheKey
    return () => {
      if (cid) useConversationsStore.getState().releaseTranscriptHead(cid)
    }
  }, [cacheKey])

  return { headHeldRef, markHeadHeld }
}
