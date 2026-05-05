import { ArrowLeft } from 'lucide-react'
import type { TranscriptEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import { TranscriptView } from '../transcript'

interface SubagentDetailViewProps {
  subagent: { agentId: string; description?: string; agentType?: string; status: string } | undefined
  subagentId: string
  transcript: TranscriptEntry[]
  loading: boolean
  showThinking: boolean
  follow: boolean
  onBack: () => void
  onUserScroll: () => void
  onReachedBottom: () => void
}

export function SubagentDetailView({
  subagent,
  subagentId,
  transcript,
  loading,
  showThinking,
  follow,
  onBack,
  onUserScroll,
  onReachedBottom,
}: SubagentDetailViewProps) {
  return (
    <>
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border bg-pink-400/5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-pink-400 hover:text-pink-300 transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          Back
        </button>
        <div className="w-px h-4 bg-border" />
        <span className="text-xs text-pink-400 font-bold">
          {subagent?.description || subagent?.agentType || 'agent'}
        </span>
        <span className="text-[10px] text-pink-400/50 font-mono">{subagentId.slice(0, 8)}</span>
        {subagent && (
          <span
            className={cn(
              'ml-auto px-1.5 py-0.5 text-[10px] uppercase font-bold',
              subagent.status === 'running' ? 'bg-active text-background' : 'bg-ended text-foreground',
            )}
          >
            {subagent.status}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {loading && transcript.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            Loading transcript...
          </div>
        ) : transcript.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            No transcript entries yet
          </div>
        ) : (
          <TranscriptView
            entries={transcript}
            follow={follow}
            showThinking={showThinking}
            onUserScroll={onUserScroll}
            onReachedBottom={onReachedBottom}
          />
        )}
      </div>
    </>
  )
}
