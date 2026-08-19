import { memo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useSwitchDiagnostics } from '@/hooks/use-switch-diagnostics'
import { canJsonStream, canTerminal } from '@/lib/types'
import { ConversationHeader } from './conversation-detail/conversation-header'
import { ConversationTabs } from './conversation-detail/conversation-tabs'
import { ConversationLoading, ConversationNotFound } from './conversation-detail/conversation-unavailable'
import { DetailFooter } from './conversation-detail/detail-footer'
import { DetailOverlays } from './conversation-detail/detail-overlays'
import { SubagentPane } from './conversation-detail/subagent-pane'
import { TabContentPanels } from './conversation-detail/tab-content-panels'
import { useConversationTab } from './conversation-detail/use-conversation-tab'
import { useDetailData } from './conversation-detail/use-detail-data'
import { useEventsFetch } from './conversation-detail/use-events-fetch'

// fallow-ignore-next-line complexity
export const ConversationDetail = memo(function ConversationDetail({ conversationId }: { conversationId: string }) {
  const {
    activeTab,
    setActiveTab,
    follow,
    setFollow,
    disableFollow,
    enableFollow,
    infoExpanded,
    setInfoExpanded,
    conversationTarget,
    setConversationTarget,
  } = useConversationTab(conversationId)

  const {
    canAdmin,
    canChat,
    canReadTerminal,
    canFiles,
    canSpawn,
    model,
    showThinking,
    showDiag,
    showTerminal,
    terminalWrapperId,
    expandAll,
    conversation,
    hydrating,
    events,
    transcript,
    sentinelConnected,
    projectSettings,
  } = useDetailData(conversationId, activeTab)

  const selectedSubagentId = useConversationsStore(s => s.selectedSubagentId)
  const selectSubagent = useConversationsStore(s => s.selectSubagent)

  const inPlanMode = conversation?.planMode ?? false

  useSwitchDiagnostics(conversationId)
  useEventsFetch(conversationId, activeTab)

  if (!conversation) {
    return hydrating ? <ConversationLoading /> : <ConversationNotFound conversationId={conversationId} />
  }

  const canSendInput = conversation.status !== 'ended' && canChat
  const hasTerminal = canTerminal(conversation)
  const hasJsonStream = canJsonStream(conversation)
  const canRevive = conversation.status === 'ended' && sentinelConnected && canSpawn

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
      <DetailOverlays conversationId={conversationId} conversationProject={conversation.project} canAdmin={canAdmin} />

      <ConversationHeader
        conversation={conversation}
        projectSettings={projectSettings}
        model={model}
        inPlanMode={inPlanMode}
        infoExpanded={infoExpanded}
        onToggleExpanded={() => setInfoExpanded(!infoExpanded)}
        onSetConversationTarget={setConversationTarget}
      />

      {selectedSubagentId && (
        <SubagentPane
          conversation={conversation}
          subagentId={selectedSubagentId}
          showThinking={showThinking}
          follow={follow}
          onBack={() => {
            selectSubagent(null)
            setFollow(true)
          }}
          onUserScroll={disableFollow}
          onReachedBottom={enableFollow}
        />
      )}

      {!selectedSubagentId && (
        <>
          <ConversationTabs
            conversation={conversation}
            activeTab={activeTab}
            onSetActiveTab={setActiveTab}
            hasTerminal={hasTerminal}
            hasJsonStream={hasJsonStream}
            canAdmin={canAdmin}
            canReadTerminal={canReadTerminal}
            showDiag={showDiag}
            expandAll={expandAll}
          />

          <TabContentPanels
            conversation={conversation}
            activeTab={activeTab}
            selectedConversationId={conversationId}
            transcript={transcript}
            events={events}
            follow={follow}
            showThinking={showThinking}
            inPlanMode={inPlanMode}
            hasTerminal={hasTerminal}
            hasJsonStream={hasJsonStream}
            showTerminal={showTerminal}
            canSendInput={canSendInput}
            canFiles={canFiles}
            conversationTarget={conversationTarget}
            onClearConversationTarget={() => setConversationTarget(null)}
            onDisableFollow={disableFollow}
            onEnableFollow={enableFollow}
          />
        </>
      )}

      <DetailFooter
        conversation={conversation}
        activeTab={activeTab}
        hasTerminal={hasTerminal}
        showTerminal={showTerminal}
        terminalWrapperId={terminalWrapperId}
        canSendInput={canSendInput}
        canSpawn={canSpawn}
        canRevive={!!canRevive}
        sentinelConnected={sentinelConnected}
        conversationTarget={conversationTarget}
        inSubagentView={!!selectedSubagentId}
      />
    </div>
  )
})
