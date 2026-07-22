import type { ProjectSettings } from '@shared/protocol'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CacheExpiredBanner } from '@/components/cache-timer'
import type { Conversation } from '@/lib/types'
import { HeaderCollapsedBar } from './header-collapsed-bar'
import { HeaderExpandedPanel } from './header-expanded-panel'
import { RecapPreview } from './header-recap-preview'
import { HeaderTitleLine } from './header-title-line'

export interface ConversationTarget {
  projectA: string
  projectB: string
  nameA: string
  nameB: string
}

interface ConversationHeaderProps {
  conversation: Conversation
  projectSettings: ProjectSettings | undefined
  model: string | undefined
  inPlanMode: boolean
  infoExpanded: boolean
  onToggleExpanded: () => void
  onSetConversationTarget: (target: ConversationTarget | null) => void
}

export function ConversationHeader({
  conversation,
  projectSettings,
  model,
  inPlanMode,
  infoExpanded,
  onToggleExpanded,
  onSetConversationTarget,
}: ConversationHeaderProps) {
  return (
    <div className="shrink-0 border-b border-border max-h-[30vh] overflow-y-auto">
      <button
        type="button"
        onClick={onToggleExpanded}
        className="w-full p-3 sm:p-4 flex items-center gap-2 hover:bg-muted/30 transition-colors"
      >
        {infoExpanded ? (
          <>
            <ChevronDown className="size-3 text-muted-foreground" />
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Conversation Info</span>
          </>
        ) : (
          <ChevronRight className="size-3 text-muted-foreground" />
        )}
        {!infoExpanded && (
          <HeaderCollapsedBar
            conversation={conversation}
            projectSettings={projectSettings}
            model={model}
            inPlanMode={inPlanMode}
          />
        )}
      </button>
      {!infoExpanded && <HeaderTitleLine conversation={conversation} />}
      {!infoExpanded && (conversation.recap || conversation.description) && (
        <RecapPreview conversation={conversation} />
      )}
      <CacheExpiredBanner
        lastTurnEndedAt={conversation.lastTurnEndedAt}
        tokenUsage={conversation.tokenUsage}
        model={model || conversation.model}
        cacheTtl={conversation.cacheTtl}
        isIdle={conversation.status === 'idle'}
      />
      {infoExpanded && (
        <HeaderExpandedPanel
          conversation={conversation}
          projectSettings={projectSettings}
          model={model}
          onSetConversationTarget={onSetConversationTarget}
        />
      )}
    </div>
  )
}
