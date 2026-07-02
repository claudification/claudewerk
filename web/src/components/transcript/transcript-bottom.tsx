/**
 * The transcript's bottom overlays: the in-flight turn UI and the pending
 * banners + queued bubbles. Extracted from TranscriptView so the Virtualizer
 * Lab placement knobs can render each block either INSIDE the last virtual
 * item (measured -- part of totalSize, native end-pin sees its growth) or
 * OUTSIDE the virtualizer below the measured stack (unmeasured -- growth is
 * pinned by TranscriptView's outside ResizeObserver while following).
 */

import {
  AskQuestionBanners,
  LinkRequestBanners,
  PermissionBanners,
  SpawnApprovalBanners,
} from '../conversation-detail/conversation-banners'
import { MemoizedGroupView } from './group-view'
import type { TranscriptSettings } from './group-view-types'
import type { DisplayGroup } from './grouping'
import { StreamingTextBlock, StreamingThinkingBlock, ThinkingSpinner } from './in-flight-decorations'
import { ThinkingPill } from './thinking-pill'

/** Streaming thinking -> streaming text -> pill -> spinner, chronological.
 *  All render null when nothing is in-flight. */
export function InFlightBlock({ conversationId }: { conversationId: string }) {
  return (
    <>
      <StreamingThinkingBlock conversationId={conversationId} />
      <StreamingTextBlock conversationId={conversationId} />
      <ThinkingPill conversationId={conversationId} />
      <ThinkingSpinner conversationId={conversationId} />
    </>
  )
}

type ResultLookup = Parameters<typeof MemoizedGroupView>[0]['getResult']

export function BannersBlock({
  conversationId,
  queuedGroups,
  getResult,
  settings,
  showThinking,
}: {
  conversationId: string
  queuedGroups: DisplayGroup[]
  getResult: ResultLookup
  settings: TranscriptSettings
  showThinking: boolean
}) {
  return (
    <>
      <div className="mt-2">
        <LinkRequestBanners conversationId={conversationId} />
        <PermissionBanners conversationId={conversationId} />
        <SpawnApprovalBanners conversationId={conversationId} />
        <AskQuestionBanners conversationId={conversationId} />
      </div>
      {queuedGroups.length > 0 && (
        <div className="mt-2 border-t border-dashed border-amber-500/30 pt-2">
          <div className="text-[10px] font-mono text-amber-500/60 px-1 mb-1">QUEUED</div>
          {queuedGroups.map((qg, i) => (
            <MemoizedGroupView
              // biome-ignore lint/suspicious/noArrayIndexKey: queued groups may share timestamp
              key={`queued-${qg.timestamp}-${i}`}
              group={qg}
              getResult={getResult}
              settings={settings}
              showThinking={showThinking}
            />
          ))}
        </div>
      )}
    </>
  )
}
