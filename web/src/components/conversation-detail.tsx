import { projectIdentityKey } from '@shared/project-uri'
import type { HookEvent } from '@shared/protocol'
import { memo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useSwitchDiagnostics } from '@/hooks/use-switch-diagnostics'
import { canJsonStream, canTerminal, type TranscriptEntry } from '@/lib/types'
import { ClipboardBanners } from './conversation-detail/conversation-banners'
import { ConversationHeader } from './conversation-detail/conversation-header'
import { DialogOverlay, InputBar } from './conversation-detail/conversation-input'
import { ConversationTabs } from './conversation-detail/conversation-tabs'
import { ReviveFooter } from './conversation-detail/revive-footer'
import { SubagentDetailView } from './conversation-detail/subagent-detail-view'
import { TabContentPanels } from './conversation-detail/tab-content-panels'
import { TaskEditorOverlay } from './conversation-detail/task-editor-overlay'
import { TerminalOverlay } from './conversation-detail/terminal-overlay'
import { useConversationTab } from './conversation-detail/use-conversation-tab'
import { useEventsFetch } from './conversation-detail/use-events-fetch'
import { useSubagentFetch } from './conversation-detail/use-subagent-fetch'
import { useTaskEditor } from './conversation-detail/use-task-editor'
import { ShareBanner } from './share-panel'

const EMPTY_EVENTS: HookEvent[] = []
const EMPTY_TRANSCRIPT: TranscriptEntry[] = []

// fallow-ignore-next-line complexity
export const ConversationDetail = memo(function ConversationDetail({ conversationId }: { conversationId: string }) {
  const showThinking = useConversationsStore(s => s.controlPanelPrefs.showThinking)
  const showDiag = useConversationsStore(s => s.controlPanelPrefs.showDiag)
  const showTerminal = useConversationsStore(state => state.showTerminal)
  const terminalWrapperId = useConversationsStore(state => state.terminalWrapperId)
  const expandAll = useConversationsStore(state => state.expandAll)

  const conversation = useConversationsStore(state => state.conversationsById[conversationId])

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

  const { canAdmin, canChat, canReadTerminal, canFiles, canSpawn } = useConversationsStore(
    useShallow(s => {
      const p = s.conversationPermissions[conversationId] || s.permissions
      return {
        canAdmin: p.canAdmin,
        canChat: p.canChat,
        canReadTerminal: p.canReadTerminal,
        canFiles: p.canFiles,
        canSpawn: p.canSpawn,
      }
    }),
  )

  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  const events = useConversationsStore(state => {
    const tab = activeTabRef.current
    if (tab !== 'events' && tab !== 'transcript' && tab !== 'tty') return EMPTY_EVENTS
    return state.events[conversationId] || EMPTY_EVENTS
  })
  const transcript = useConversationsStore(state => {
    const tab = activeTabRef.current
    if (tab !== 'transcript' && tab !== 'tty') return EMPTY_TRANSCRIPT
    return state.transcripts[conversationId] || EMPTY_TRANSCRIPT
  })
  const sentinelConnected = useConversationsStore(state => state.sentinelConnected)
  const projectSettings = useConversationsStore(state =>
    conversation?.project ? state.projectSettings[projectIdentityKey(conversation.project)] : undefined,
  )

  const { selectedSubagentId, selectSubagent, subagentTranscript, subagentLoading } = useSubagentFetch(conversationId)
  const { taskEditorTask, runTaskFromEditor, updateTask, moveTask, setRunTaskFromEditor, setTaskEditorTask } =
    useTaskEditor(conversationId)

  const inPlanMode = conversation?.planMode ?? false

  useSwitchDiagnostics(conversationId)
  useEventsFetch(conversationId, activeTab)

  if (!conversation) return null

  const model = (events.find(e => e.hookEvent === 'SessionStart')?.data as { model?: string } | undefined)?.model
  const canSendInput = conversation.status !== 'ended' && canChat
  const hasTerminal = canTerminal(conversation)
  const hasJsonStream = canJsonStream(conversation)
  const canRevive = conversation.status === 'ended' && sentinelConnected && canSpawn

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
      <ClipboardBanners conversationId={conversationId} />
      {canAdmin && <ShareBanner conversationProject={conversation.project} conversationId={conversation.id} />}
      <DialogOverlay conversationId={conversationId} />

      <TaskEditorOverlay
        conversationId={conversationId}
        taskEditorTask={taskEditorTask}
        runTaskFromEditor={runTaskFromEditor}
        onUpdateTask={updateTask}
        onMoveTask={moveTask}
        onRunTask={setRunTaskFromEditor}
        onCloseEditor={() => setTaskEditorTask(null)}
        onCloseRunDialog={() => setRunTaskFromEditor(null)}
        onSetTaskEditorTask={setTaskEditorTask}
      />

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
        <SubagentDetailView
          conversationId={conversationId}
          subagent={conversation.subagents.find(a => a.agentId === selectedSubagentId)}
          subagentId={selectedSubagentId}
          transcript={subagentTranscript}
          loading={subagentLoading}
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

      {!conversationTarget &&
        canSendInput &&
        (activeTab === 'transcript' || (activeTab === 'tty' && !hasTerminal)) &&
        !selectedSubagentId && <InputBar conversationId={conversationId} />}

      {showTerminal && terminalWrapperId && <TerminalOverlay conversationId={terminalWrapperId} />}

      {conversation.status === 'ended' && canSpawn && (
        <ReviveFooter
          conversationId={conversationId}
          project={conversation.project}
          sentinelConnected={sentinelConnected}
          canRevive={!!canRevive}
          backend={conversation.backend}
        />
      )}
    </div>
  )
})
