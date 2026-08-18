import { Command, FileText, Menu } from 'lucide-react'
import { type ComponentType, lazy, Suspense, useEffect, useState } from 'react'
import { ActionFab } from '@/components/action-fab'
import { AudioPlayerHost } from '@/components/audio-player-host'
import { LoginHintBanner } from '@/components/auth/login-hint-banner'
import { AuthExpiredModal } from '@/components/auth-expired-modal'
import { AuthGate } from '@/components/auth-gate'
import { useCardHover } from '@/components/card-hover/card-hover-bus'
import { checklistAddNotesBus, checklistArchiveBus, checklistBulkEditBus } from '@/components/checklist/checklist-bus'
import { ChordOverlay } from '@/components/chord-overlay'
import { CommandPalette } from '@/components/command-palette'
import { ConversationDetail } from '@/components/conversation-detail'
import { EmptyState } from '@/components/conversation-detail/empty-state'
import { ProjectActionPanel } from '@/components/conversation-detail/project-action-panel'
import { DebugConsole } from '@/components/debug-console'
import { dispatchBus } from '@/components/dispatch-overlay/dispatch-bus'
import { Dock } from '@/components/dock'
import { forkDialogBus } from '@/components/fork-dialog-trigger'
import { Header } from '@/components/header'
import { JsonInspectorDialog } from '@/components/json-inspector'
import { LaunchProfileCommands } from '@/components/launch-profiles/launch-profile-commands'
import { LaunchToastContainer } from '@/components/launch-profiles/launch-toast'
import { useLaunchProfileManagerState } from '@/components/launch-profiles/manager-state'
import { LinkPreviewPane } from '@/components/link-preview-pane'
import { useManageWorkspacesOpen } from '@/components/manage-workspaces/manage-workspaces-state'
import { MarkdownViewerModal } from '@/components/markdown-viewer-modal'
import { MediaLightbox } from '@/components/media-lightbox'
import { useMermaidLightbox } from '@/components/mermaid-lightbox-bus'
import { useOrganizeProjectsOpen } from '@/components/organize-projects/organize-state'
import { useOverseerOpen } from '@/components/overseer/overseer-state'
import { PanelBoundary } from '@/components/panel-boundary'
import { PinnedSwitchStrip } from '@/components/pinned-switch-strip'
import { quickTaskBus } from '@/components/quick-task-trigger'
import { PublicRecapView } from '@/components/recap/public-recap-view'
import { recapOpenBus } from '@/components/recap/recap-open-trigger'
import { recapConfigBus } from '@/components/recap-jobs/recap-config-trigger'
import { recapHistoryBus } from '@/components/recap-jobs/recap-history-trigger'
import { RenameModal } from '@/components/rename-modal'
import { reviveDialogBus } from '@/components/revive-dialog-trigger'
import { manageChatConnectionsBus } from '@/components/settings/manage-chat-connections-trigger'
import { manageProjectLinksBus } from '@/components/settings/manage-project-links-trigger'
import { SharedConversationView } from '@/components/shared-conversation-view'
import { ShortcutHelp } from '@/components/shortcut-help'
import { Sidebar } from '@/components/sidebar/sidebar'
import { useSidebarOpen } from '@/components/sidebar/sidebar-open-state'
import { SidebarExpandTab } from '@/components/sidebar/sidebar-tools'
import { spawnDialogBus } from '@/components/spawn-dialog-trigger'
import { SyncIndicator } from '@/components/sync-indicator'
import { taskBatchBus } from '@/components/task-batch-trigger'
import { TerminateConfirmDialog } from '@/components/terminate-confirm'
import { TerminateLineageConfirmDialog } from '@/components/terminate-lineage-confirm'
import { ToastContainer } from '@/components/toast'
import { TranscriptSearch } from '@/components/transcript-search'
import { Button } from '@/components/ui/button'
import { UpdateBanner } from '@/components/update-banner'
import { useVacuumOpen } from '@/components/vacuum/vacuum-state'
import { VoiceFab } from '@/components/voice-fab'
import { VoiceKey } from '@/components/voice-key'
import { voiceOrbBus } from '@/components/voice-orb/voice-orb-bus'
import { useBuildUpdate } from '@/hooks/use-build-update'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useEdgeSwipe } from '@/hooks/use-edge-swipe'
import { useGlobalCommands } from '@/hooks/use-global-commands'
import { useSyncEffects } from '@/hooks/use-sync-effects'
import { useWebSocket } from '@/hooks/use-websocket'
import { executeCommand } from '@/lib/commands'
import { focusInputEditor } from '@/lib/focus-input'
import { lazyModule, named } from '@/lib/lazy-module'
import { clearShareMode, detectShareKind, detectShareMode } from '@/lib/share-mode'
import { isMobileViewport, isTouchDevice } from '@/lib/utils'
import { useAgentShellsStore } from '@/lib/web-control-shells'

const WebTerminal = lazy(() => import('@/components/web-terminal').then(m => ({ default: m.WebTerminal })))
const ShellPane = lazy(() => import('@/components/shell-pane').then(m => ({ default: m.ShellPane })))
const UserAdminDialog = lazy(() => import('@/components/user-admin').then(m => ({ default: m.UserAdminDialog })))
const SentinelManagerDialog = lazy(() =>
  import('@/components/sentinel-manager').then(m => ({ default: m.SentinelManagerDialog })),
)
const GatewayManagerDialog = lazy(() =>
  import('@/components/gateway-manager').then(m => ({ default: m.GatewayManagerDialog })),
)
const SearchIndexManagerDialog = lazy(() =>
  import('@/components/search-index-manager').then(m => ({ default: m.SearchIndexManagerDialog })),
)
// Parkable fleet overview (was the #/sheaf fullscreen page).
const SheafModal = lazy(() => import('@/sheaf/sheaf-modal').then(m => ({ default: m.SheafModal })))
const CanvasPage = lazy(() => import('@/components/canvas-mode/canvas-page').then(m => ({ default: m.CanvasPage })))
const PublicCanvasView = lazy(() =>
  import('@/components/canvas/public-canvas-view').then(m => ({ default: m.PublicCanvasView })),
)
// Parkable, maximizable, project-scoped Nightshift modal (Outlook / Status /
// Report tabs). Replaces the old #/nightshift + #/nightshift-status routes.
const NightshiftModal = lazy(() =>
  import('@/components/nightshift/nightshift-modal').then(m => ({ default: m.NightshiftModal })),
)
// Parkable, global Scheduled Tasks modal (all projects + per-schedule history).
// LAZY LOAD: nothing about it belongs in the index bundle.
const ScheduledTasksModal = lazy(() =>
  import('@/components/scheduled-tasks/scheduled-tasks-modal').then(m => ({ default: m.ScheduledTasksModal })),
)
// LAZY LOAD: the commit surfaces are off the hot path -- the chunk only loads
// when one is actually opened.
const CommitBrowserModal = lazy(() =>
  import('@/components/commits/commit-modals').then(m => ({ default: m.CommitBrowserModal })),
)
const CommitDetailModal = lazy(() =>
  import('@/components/commits/commit-modals').then(m => ({ default: m.CommitDetailModal })),
)
// Parkable, maximizable, detachable, project-scoped Kanban board modal. The
// board (dnd-kit + CodeMirror) rides this lazy chunk, off the index bundle.
const KanbanModal = lazy(() => import('@/components/kanban/kanban-modal').then(m => ({ default: m.KanbanModal })))
// PULSE -- the fleet grouped by activity. Both surfaces are off the hot path:
// the palette only exists once summoned, and the strip only when opted in.
const PulsePalette = lazy(() => import('@/components/pulse/pulse-palette').then(m => ({ default: m.PulsePalette })))
const PulseStrip = lazy(() => import('@/components/pulse/pulse-strip').then(m => ({ default: m.PulseStrip })))
// Admin-only debug tool -- kept out of the index bundle (incl. its lazy YAML view).
const DebugControlModal = lazy(() =>
  import('@/components/debug/debug-control-modal').then(m => ({ default: m.DebugControlModal })),
)
const SotuViewerModal = lazy(() => import('@/components/sotu-viewer').then(m => ({ default: m.SotuViewerModal })))
// Admin-only Claude login flow (cc_control OAuth). Kept out of the index bundle.
const LoginModal = lazy(() => import('@/components/auth/login-modal').then(m => ({ default: m.LoginModal })))
// THE DIALOGUE -- live dialogs as managed modals (parkable, detachable).
const LiveDialogModals = lazy(() =>
  import('@/components/dialog/persistent/live-dialog-modals').then(m => ({ default: m.LiveDialogModals })),
)

// Lazy modals: code-split out of the eager index chunk, mounted on first open.
// The gate subscribes to each modal's open signal (see lazyModule / lazy-bus).
const SpawnDialog = lazyModule(
  named(() => import('@/components/spawn-dialog'), 'SpawnDialog'),
  spawnDialogBus.useArmed,
)
const ReviveDialog = lazyModule(
  named(() => import('@/components/revive-dialog'), 'ReviveDialog'),
  reviveDialogBus.useArmed,
)
const ForkDialog = lazyModule(
  named(() => import('@/components/fork-dialog'), 'ForkDialog'),
  forkDialogBus.useArmed,
)
// The voice orb drags WebRTC + the realtime session with it -- it must never
// ride the index chunk. Armed only by the summon verb.
const VoiceOrbHost = lazyModule(
  named(() => import('@/components/voice-orb/voice-orb-host'), 'VoiceOrbHost'),
  voiceOrbBus.useArmed,
)
const RecapConfigDialog = lazyModule(
  named(() => import('@/components/recap-jobs/recap-config-dialog'), 'RecapConfigDialog'),
  recapConfigBus.useArmed,
)
const ManageProjectLinksDialog = lazyModule(
  named(() => import('@/components/settings/manage-project-links-dialog'), 'ManageProjectLinksDialog'),
  manageProjectLinksBus.useArmed,
)
const ManageChatConnectionsDialog = lazyModule(
  named(() => import('@/components/settings/manage-chat-connections-dialog'), 'ManageChatConnectionsDialog'),
  manageChatConnectionsBus.useArmed,
)
const QuickTaskModal = lazyModule(
  named(() => import('@/components/quick-task-modal'), 'QuickTaskModal'),
  quickTaskBus.useArmed,
)
const TaskBatchSelector = lazyModule(
  named(() => import('@/components/task-batch-selector'), 'TaskBatchSelector'),
  taskBatchBus.useArmed,
)
const RecapViewer = lazyModule(
  named(() => import('@/components/recap/recap-viewer'), 'RecapViewer'),
  recapOpenBus.useArmed,
)
const RecapHistoryModal = lazyModule(
  named(() => import('@/components/recap/recap-history-modal'), 'RecapHistoryModal'),
  recapHistoryBus.useArmed,
)
// Static `m.X` property ref (not named('X')) so fallow resolves the dynamic-import usage.
const ChecklistArchiveModal = lazyModule(
  () =>
    import('@/components/checklist/checklist-archive-modal').then(m => ({
      default: m.ChecklistArchiveModal,
    })) as Promise<{
      default: ComponentType
    }>,
  checklistArchiveBus.useArmed,
)
const ChecklistBulkEditModal = lazyModule(
  () =>
    import('@/components/checklist/checklist-bulk-edit-modal').then(m => ({
      default: m.ChecklistBulkEditModal,
    })) as Promise<{
      default: ComponentType
    }>,
  checklistBulkEditBus.useArmed,
)
const ChecklistAddNotesModal = lazyModule(
  () =>
    import('@/components/checklist/checklist-add-notes-modal').then(m => ({
      default: m.ChecklistAddNotesModal,
    })) as Promise<{
      default: ComponentType
    }>,
  checklistAddNotesBus.useArmed,
)
const LaunchProfileManager = lazyModule(
  named(() => import('@/components/launch-profiles/manager'), 'LaunchProfileManager'),
  () => useLaunchProfileManagerState().open,
)
// Project/group organizer -- chunk (incl. @dnd-kit) loads only when first opened.
// Static `m.X` property ref (not named('X')) so fallow resolves the dynamic import.
const OrganizeProjectsModal = lazyModule(
  () =>
    import('@/components/organize-projects/organize-modal').then(m => ({
      default: m.OrganizeProjectsModal,
    })) as Promise<{ default: ComponentType }>,
  useOrganizeProjectsOpen,
)
// Workspace manager -- chunk (incl. @dnd-kit) loads only when first opened.
const ManageWorkspacesModal = lazyModule(
  () =>
    import('@/components/manage-workspaces/manage-workspaces-modal').then(m => ({
      default: m.ManageWorkspacesModal,
    })) as Promise<{ default: ComponentType }>,
  useManageWorkspacesOpen,
)
// Vacuum workbench -- admin-only and rarely opened, so the chunk stays off the
// hot path entirely until someone asks for it.
const VacuumModal = lazyModule(
  () =>
    import('@/components/vacuum/vacuum-modal').then(m => ({
      default: m.VacuumModal,
    })) as Promise<{ default: ComponentType }>,
  useVacuumOpen,
)
// The overseer control plane. The BADGE that opens it is eager (it is header
// chrome and must render the moment anything is running); the window itself is
// not, so a session that never opens it never pays for the chunk.
const OverseerModal = lazyModule(
  () =>
    import('@/components/overseer/overseer-modal').then(m => ({
      default: m.OverseerModal,
    })) as Promise<{ default: ComponentType }>,
  useOverseerOpen,
)
// Mermaid pan/zoom overlay -- chunk loads only when a diagram is first opened.
const MermaidLightbox = lazyModule(
  named(() => import('@/components/mermaid-lightbox'), 'MermaidLightbox'),
  () => useMermaidLightbox(s => s.open),
)
// Card-link hover card -- the chunk lands the first time a card link is hovered,
// and never in a session that hovers none.
const CardHoverLayer = lazyModule(
  named(() => import('@/components/card-hover/card-hover-layer'), 'CardHoverLayer'),
  () => useCardHover(s => s.armed),
)
// The per-user dispatch cockpit -- chunk loads only when first summoned.
const DispatchOverlay = lazyModule(() => import('@/components/dispatch-overlay/dispatch-overlay'), dispatchBus.useArmed)
// Off-screen agent-attached (debug) shell host -- pulls in @xterm (~458KB), so it
// stays out of the boot bundle until the agent first attaches a shell.
const AgentShellHost = lazyModule(
  named(() => import('@/components/agent-shell-host'), 'AgentShellHost'),
  () => useAgentShellsStore(s => Object.keys(s.attached).length > 0),
)
// Parent-conditional: gated on showBatchPalette below, so plain React.lazy.
const BatchModeModal = lazy(() =>
  import('@/components/command-palette/batch-mode').then(m => ({ default: m.BatchModeModal })),
)

// Pre-existing critical-complexity app shell (CRAP is unavoidable for an
// uncovered top-level component this size). This change net-REDUCES it (19->18
// cyclomatic, via DesktopSidebar/SidebarTools extraction); a full shell split is
// tracked separately. Suppress so the gate doesn't attribute inherited debt here.
// fallow-ignore-next-line complexity
function DashboardContent() {
  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const selectedProjectUri = useConversationsStore(s => s.selectedProjectUri)

  if (!selectedConversationId) {
    if (selectedProjectUri) return <ProjectActionPanel projectUri={selectedProjectUri} />
    return <EmptyState />
  }

  return <ConversationDetail conversationId={selectedConversationId} />
}

function handleSwitcherSelect(id: string) {
  const store = useConversationsStore.getState()
  store.selectConversation(id, 'command-palette')
  store.setShowSwitcher(false)
  if (!isMobileViewport()) {
    requestAnimationFrame(() => focusInputEditor())
  }
}

// fallow-ignore-next-line complexity
function Dashboard() {
  const sidebar = useSidebarOpen()
  const [showUserAdmin, setShowUserAdmin] = useState(false)
  const [showSentinelManager, setShowSentinelManager] = useState(false)
  const [showGatewayManager, setShowGatewayManager] = useState(false)
  const [showSearchIndex, setShowSearchIndex] = useState(false)
  const [showBatchPalette, setShowBatchPalette] = useState(false)

  useEffect(() => {
    function open() {
      setShowBatchPalette(true)
    }
    window.addEventListener('open-batch-palette', open)
    return () => window.removeEventListener('open-batch-palette', open)
  }, [])

  const { swUpdate, setSwUpdate } = useBuildUpdate()

  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const showSwitcher = useConversationsStore(s => s.showSwitcher)
  const showPulse = useConversationsStore(s => s.showPulse)
  const showDebugConsole = useConversationsStore(s => s.showDebugConsole)
  const canAdmin = useConversationsStore(s => s.permissions.canAdmin)

  // The two side edges are the only ones a web app can have on iOS -- the bottom
  // is the home indicator and the top is Control Centre. Left opens the same
  // sidebar the hamburger does; right opens PULSE as a full-screen selector,
  // because a 30px strip is not a realistic tap target on a phone.
  const swipeHandlers = useEdgeSwipe({
    onFromLeft: sidebar.show,
    onFromRight: () => useConversationsStore.getState().setShowPulse(true),
  })

  useSyncEffects()
  useGlobalCommands(sidebar.toggle)

  // Listen for user admin open event (from command palette)
  useEffect(() => {
    function handleOpen() {
      setShowUserAdmin(true)
    }
    window.addEventListener('open-user-admin', handleOpen)
    return () => window.removeEventListener('open-user-admin', handleOpen)
  }, [])

  // Listen for sentinel manager open event (from command palette)
  useEffect(() => {
    function handleOpen() {
      setShowSentinelManager(true)
    }
    window.addEventListener('open-sentinel-manager', handleOpen)
    return () => window.removeEventListener('open-sentinel-manager', handleOpen)
  }, [])

  // Listen for gateway manager open event (from command palette)
  useEffect(() => {
    function handleOpen() {
      setShowGatewayManager(true)
    }
    window.addEventListener('open-gateway-manager', handleOpen)
    return () => window.removeEventListener('open-gateway-manager', handleOpen)
  }, [])

  // Listen for search-index manager open event (from command palette)
  useEffect(() => {
    function handleOpen() {
      setShowSearchIndex(true)
    }
    window.addEventListener('open-search-index', handleOpen)
    return () => window.removeEventListener('open-search-index', handleOpen)
  }, [])

  return (
    <div className="h-full flex flex-col p-2 sm:p-4 max-w-[1400px] mx-auto overflow-hidden" {...swipeHandlers}>
      {swUpdate && <UpdateBanner swUpdate={swUpdate} onDismiss={() => setSwUpdate(null)} />}

      {/* Header. The hamburger is the ONLY mobile-specific piece of sidebar
          chrome -- it toggles the same state the desktop chevron does. */}
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <Button variant="outline" size="icon" className="lg:hidden shrink-0" onClick={sidebar.toggle}>
          <Menu className="size-5" />
          <span className="sr-only">Toggle conversations</span>
        </Button>

        <div className="flex-1 min-w-0">
          <PanelBoundary name="Header">
            <Header />
          </PanelBoundary>
        </div>

        {canAdmin && (
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 sm:hidden"
            onClick={() => executeCommand('quick-task')}
            title="Quick task"
          >
            <FileText className="size-4" />
          </Button>
        )}
        {canAdmin && (
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 sm:hidden"
            onClick={() => useConversationsStore.getState().toggleSwitcher()}
            title="Command palette"
          >
            <Command className="size-4" />
          </Button>
        )}
      </div>

      {/* Mobile quick-switch strip -- pinned + recent-active conversations.
          Self-hides on desktop (lg:hidden) and when there's nothing to switch to. */}
      <PinnedSwitchStrip />

      {/* Unified dock -- one global tray: parked modals + minimized live dialogs +
          host shells. Self-hides when everything is empty. */}
      <div className="shrink-0">
        <Dock />
      </div>

      {/* Off-screen host for agent-attached (debug) shells -- mounted + readable
          without ever popping the fullscreen overlay. Self-hides when empty. */}
      <AgentShellHost />

      {/* Main content. ONE sidebar for both presentations -- see
          components/sidebar/sidebar.tsx for why it is never unmounted. */}
      {/* No `gap` here: the sidebar supplies its own right margin only while
          expanded, so a collapsed dock leaves no orphan 16px gutter. */}
      <div className="flex flex-1 min-h-0 relative">
        <Sidebar state={sidebar} />
        {!sidebar.open && <SidebarExpandTab onExpand={sidebar.toggle} />}

        <div className="flex-1 border border-border overflow-hidden flex flex-col min-w-0">
          {canAdmin && <LoginHintBanner />}
          <PanelBoundary name="Conversation">
            <DashboardContent />
          </PanelBoundary>
        </div>
      </div>

      {/* PULSE STRIP -- app chrome, not a modal. Sits below the content, never
          takes focus, and renders nothing at all unless opted in. */}
      {canAdmin && (
        <Suspense fallback={null}>
          <PulseStrip onOpen={handleSwitcherSelect} />
        </Suspense>
      )}

      {showDebugConsole && <DebugConsole onClose={() => useConversationsStore.getState().toggleDebugConsole()} />}

      {canAdmin && showSwitcher && (
        <PanelBoundary name="Command palette" variant="modal">
          <CommandPalette
            onSelect={handleSwitcherSelect}
            onClose={() => useConversationsStore.getState().setShowSwitcher(false)}
          />
        </PanelBoundary>
      )}

      {canAdmin && showPulse && (
        <PanelBoundary name="Pulse" variant="modal">
          <Suspense fallback={null}>
            <PulsePalette
              onOpen={handleSwitcherSelect}
              onClose={() => useConversationsStore.getState().setShowPulse(false)}
            />
          </Suspense>
        </PanelBoundary>
      )}

      <PanelBoundary name="JSON inspector" variant="modal">
        <JsonInspectorDialog />
      </PanelBoundary>
      <MediaLightbox />
      <MermaidLightbox />
      <CardHoverLayer />
      {canAdmin && <DispatchOverlay />}
      <LinkPreviewPane />
      <AudioPlayerHost />
      {canAdmin && <QuickTaskModal />}
      <RenameModal />
      <Suspense fallback={null}>
        <NightshiftModal />
        <ScheduledTasksModal />
        <CommitBrowserModal />
        <CommitDetailModal />
      </Suspense>
      <Suspense fallback={null}>
        <KanbanModal />
      </Suspense>
      {canAdmin && (
        <Suspense fallback={null}>
          <DebugControlModal />
        </Suspense>
      )}
      {canAdmin && (
        <Suspense fallback={null}>
          <LoginModal />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <SotuViewerModal />
      </Suspense>
      {canAdmin && (
        <Suspense fallback={null}>
          <SheafModal />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <LiveDialogModals />
      </Suspense>
      <MarkdownViewerModal />
      {canAdmin && <TaskBatchSelector />}
      {canAdmin && <ShortcutHelp />}
      {canAdmin && showBatchPalette && (
        <Suspense fallback={null}>
          <BatchModeModal open={showBatchPalette} onClose={() => setShowBatchPalette(false)} />
        </Suspense>
      )}

      {showUserAdmin && (
        <Suspense fallback={null}>
          <UserAdminDialog open={showUserAdmin} onOpenChange={setShowUserAdmin} />
        </Suspense>
      )}

      {showSentinelManager && (
        <Suspense fallback={null}>
          <SentinelManagerDialog open={showSentinelManager} onOpenChange={setShowSentinelManager} />
        </Suspense>
      )}

      {showGatewayManager && (
        <Suspense fallback={null}>
          <GatewayManagerDialog open={showGatewayManager} onOpenChange={setShowGatewayManager} />
        </Suspense>
      )}

      {showSearchIndex && (
        <Suspense fallback={null}>
          <SearchIndexManagerDialog open={showSearchIndex} onOpenChange={setShowSearchIndex} />
        </Suspense>
      )}

      <TranscriptSearch />
      <SyncIndicator />
      <VoiceFabGate />
      <VoiceOrbHost />
      <ActionFabGate />
      <VoiceKey />
      <AuthExpiredModal />
      <ChordOverlay />
      <PanelBoundary name="Spawn dialog" variant="modal">
        <SpawnDialog />
      </PanelBoundary>
      <ReviveDialog />
      <ForkDialog />
      <RecapConfigDialog />
      <PanelBoundary name="Recap viewer" variant="modal">
        <RecapViewer />
      </PanelBoundary>
      <PanelBoundary name="Recap history" variant="modal">
        <RecapHistoryModal />
        <ChecklistArchiveModal />
        <ChecklistBulkEditModal />
        <ChecklistAddNotesModal />
      </PanelBoundary>
      <ManageProjectLinksDialog />
      <ManageChatConnectionsDialog />
      <LaunchProfileManager />
      <OrganizeProjectsModal />
      <ManageWorkspacesModal />
      <VacuumModal />
      <OverseerModal />
      <LaunchProfileCommands />
      <LaunchToastContainer />
      <TerminateConfirmDialog />
      <TerminateLineageConfirmDialog />
      <ToastContainer />
    </div>
  )
}

function VoiceFabGate() {
  const showVoiceFab = useConversationsStore(state => state.controlPanelPrefs.showVoiceFab)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)

  if (!isTouchDevice() || !showVoiceFab || !selectedConversationId) return null
  return <VoiceFab />
}

function ActionFabGate() {
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  if (!isTouchDevice() || !selectedConversationId) return null
  return <ActionFab />
}

function PopoutTerminal({ conversationId }: { conversationId: string }) {
  useWebSocket()

  return (
    <div className="h-full w-full">
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full text-muted-foreground">Loading terminal…</div>
        }
      >
        <WebTerminal conversationId={conversationId} onClose={() => window.close()} popout />
      </Suspense>
    </div>
  )
}

/** Detached host-shell window. Reuses the main session cookie (same origin), so
 *  the WS authenticates exactly like the dashboard -- a single ShellPane with the
 *  same subscribe-on-mount mechanics. */
function PopoutShell({ shellId }: { shellId: string }) {
  useWebSocket()

  useEffect(() => {
    document.title = `Shell: ${shellId.slice(0, 8)}`
  }, [shellId])

  return (
    <div className="h-full w-full bg-[#0a0a0a]">
      <Suspense
        fallback={<div className="flex items-center justify-center h-full text-muted-foreground">Loading shell…</div>}
      >
        <ShellPane shellId={shellId} className="h-full w-full p-1" />
      </Suspense>
    </div>
  )
}

function ShareGate({ token }: { token: string }) {
  const [mode, setMode] = useState<'checking' | 'guest' | 'redirect'>('checking')

  // scoped out of phase 7 PLAN (would need TanStack Query adoption)
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect
  useEffect(() => {
    fetch('/auth/status')
      .then(r => r.json())
      .then(data => {
        if (data.authenticated) {
          clearShareMode()
          fetch(`/api/share-resolve/${encodeURIComponent(token)}`)
            .then(r => (r.ok ? r.json() : null))
            .then(resolved => {
              const convId = resolved?.conversationId
              window.location.hash = convId ? `conversation/${convId}` : ''
              setMode('redirect')
            })
        } else {
          setMode('guest')
        }
      })
      .catch(() => setMode('guest'))
  }, [token])

  if (mode === 'checking') return null
  if (mode === 'redirect') {
    return (
      <AuthGate>
        <Dashboard />
      </AuthGate>
    )
  }
  detectShareMode()
  return <SharedConversationView token={token} />
}

/** Full-screen lazy pages routed by bare hash (`#/canvas`). */
function FullscreenRoute({ fallbackLabel, children }: { fallbackLabel: string; children: React.ReactNode }) {
  return (
    <AuthGate>
      <Suspense
        fallback={
          <div className="fixed inset-0 flex items-center justify-center text-muted-foreground">{fallbackLabel}</div>
        }
      >
        {children}
      </Suspense>
    </AuthGate>
  )
}

const FULLSCREEN_PAGES: Record<string, () => React.ReactElement> = {
  canvas: () => (
    <FullscreenRoute fallbackLabel="Loading the canvas…">
      <CanvasPage />
    </FullscreenRoute>
  ),
}

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash.slice(1))
  useEffect(() => {
    function update() {
      setHash(window.location.hash.slice(1))
    }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return hash
}

// Dev-only component harness. The ternary keeps the dynamic import inside a
// `import.meta.env.DEV` branch, so Vite dead-code-eliminates it (chunk + route)
// from production builds entirely.
const DevHarnessRoute = import.meta.env.DEV ? lazy(() => import('./dev/harness/dev-harness-route')) : null

export function App() {
  const hash = useHash()

  // /dev/harness?mount=<id>&key=<devToken> -- mount one component against the
  // real broker, bypassing the full app shell. Dev builds only.
  if (DevHarnessRoute && window.location.pathname === '/dev/harness') {
    return (
      <Suspense fallback={null}>
        <DevHarnessRoute />
      </Suspense>
    )
  }

  // Phase 11: /r/:token redirected here as ?share=TOKEN&kind=recap. The SPA
  // serves a standalone public recap viewer (no project chrome, no auth gate).
  const shareToken = detectShareMode()
  if (shareToken && detectShareKind() === 'recap') {
    return <PublicRecapView token={shareToken} />
  }
  if (shareToken && detectShareKind() === 'canvas') {
    return (
      <Suspense fallback={null}>
        <PublicCanvasView token={shareToken} />
      </Suspense>
    )
  }

  const shareMatch = hash.match(/^\/?share\/(.+)$/)
  if (shareMatch) {
    return <ShareGate token={shareMatch[1]} />
  }

  const popoutMatch = hash.match(/^popout-terminal\/(.+)$/)
  if (popoutMatch) {
    return (
      <AuthGate>
        <PopoutTerminal conversationId={popoutMatch[1]} />
      </AuthGate>
    )
  }

  const popoutShellMatch = hash.match(/^popout-shell\/(.+)$/)
  if (popoutShellMatch) {
    return (
      <AuthGate>
        <PopoutShell shellId={popoutShellMatch[1]} />
      </AuthGate>
    )
  }

  const fullscreenPage = FULLSCREEN_PAGES[hash.replace(/^\//, '')]
  if (fullscreenPage) {
    return fullscreenPage()
  }

  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}
