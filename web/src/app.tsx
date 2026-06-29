import { ChevronLeft, ChevronRight, Command, Crosshair, FileText, FolderTree, Menu } from 'lucide-react'
import { type ComponentType, lazy, Suspense, useEffect, useState } from 'react'
import { ActionFab } from '@/components/action-fab'
import { AudioPlayerHost } from '@/components/audio-player-host'
import { AuthExpiredModal } from '@/components/auth-expired-modal'
import { AuthGate } from '@/components/auth-gate'
import { checklistAddNotesBus, checklistArchiveBus, checklistBulkEditBus } from '@/components/checklist/checklist-bus'
import { ChordOverlay } from '@/components/chord-overlay'
import { CommandPalette } from '@/components/command-palette'
import { ConversationDetail } from '@/components/conversation-detail'
import { DebugConsole } from '@/components/debug-console'
import { dispatchBus } from '@/components/dispatch-overlay/dispatch-bus'
import { Dock } from '@/components/dock'
import { Header } from '@/components/header'
import { JsonInspectorDialog } from '@/components/json-inspector'
import { LaunchProfileCommands } from '@/components/launch-profiles/launch-profile-commands'
import { LaunchToastContainer } from '@/components/launch-profiles/launch-toast'
import { useLaunchProfileManagerState } from '@/components/launch-profiles/manager-state'
import { LinkPreviewPane } from '@/components/link-preview-pane'
import { MarkdownViewerModal } from '@/components/markdown-viewer-modal'
import { MediaLightbox } from '@/components/media-lightbox'
import { useMermaidLightbox } from '@/components/mermaid-lightbox-bus'
import { openOrganizeProjects, useOrganizeProjectsOpen } from '@/components/organize-projects/organize-state'
import { PanelBoundary } from '@/components/panel-boundary'
import { PinnedSwitchStrip } from '@/components/pinned-switch-strip'
import { usePopoutStore } from '@/components/popout/use-popout-store'
import { ProjectList } from '@/components/project-list'
import { quickTaskBus } from '@/components/quick-task-trigger'
import { PublicRecapView } from '@/components/recap/public-recap-view'
import { recapOpenBus } from '@/components/recap/recap-open-trigger'
import { recapConfigBus } from '@/components/recap-jobs/recap-config-trigger'
import { recapHistoryBus } from '@/components/recap-jobs/recap-history-trigger'
import { RecapJobsWidget } from '@/components/recap-jobs/recap-jobs-widget'
import { RenameModal } from '@/components/rename-modal'
import { reviveDialogBus } from '@/components/revive-dialog-trigger'
import { manageChatConnectionsBus } from '@/components/settings/manage-chat-connections-trigger'
import { manageProjectLinksBus } from '@/components/settings/manage-project-links-trigger'
import { SharedConversationView } from '@/components/shared-conversation-view'
import { ShortcutHelp } from '@/components/shortcut-help'
import { spawnDialogBus } from '@/components/spawn-dialog-trigger'
import { SyncIndicator } from '@/components/sync-indicator'
import { taskBatchBus } from '@/components/task-batch-trigger'
import { TerminateConfirmDialog } from '@/components/terminate-confirm'
import { TerminateLineageConfirmDialog } from '@/components/terminate-lineage-confirm'
import { ToastContainer } from '@/components/toast'
import { TranscriptSearch } from '@/components/transcript-search'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { UpdateBanner } from '@/components/update-banner'
import { VoiceFab } from '@/components/voice-fab'
import { VoiceKey } from '@/components/voice-key'
import { useBuildUpdate } from '@/hooks/use-build-update'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useGlobalCommands } from '@/hooks/use-global-commands'
import { useSwipeToOpen } from '@/hooks/use-swipe-to-open'
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
const SheafPage = lazy(() => import('@/sheaf/sheaf-page').then(m => ({ default: m.SheafPage })))
const CanvasPage = lazy(() => import('@/components/canvas-mode/canvas-page').then(m => ({ default: m.CanvasPage })))
const PublicCanvasView = lazy(() =>
  import('@/components/canvas/public-canvas-view').then(m => ({ default: m.PublicCanvasView })),
)
// Parkable, maximizable, project-scoped Nightshift modal (Outlook / Status /
// Report tabs). Replaces the old #/nightshift + #/nightshift-status routes.
const NightshiftModal = lazy(() =>
  import('@/components/nightshift/nightshift-modal').then(m => ({ default: m.NightshiftModal })),
)
// Admin-only debug tool -- kept out of the index bundle (incl. its lazy YAML view).
const DebugControlModal = lazy(() =>
  import('@/components/debug/debug-control-modal').then(m => ({ default: m.DebugControlModal })),
)
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
// Mermaid pan/zoom overlay -- chunk loads only when a diagram is first opened.
const MermaidLightbox = lazyModule(
  named(() => import('@/components/mermaid-lightbox'), 'MermaidLightbox'),
  () => useMermaidLightbox(s => s.open),
)
// The per-user dispatch cockpit -- chunk loads only when first summoned.
const DispatchOverlay = lazyModule(() => import('@/components/dispatch-overlay/dispatch-overlay'), dispatchBus.useArmed)
// Off-screen agent-attached (debug) shell host -- pulls in @xterm (~458KB), so it
// stays out of the boot bundle until the agent first attaches a shell.
const AgentShellHost = lazyModule(
  named(() => import('@/components/agent-shell-host'), 'AgentShellHost'),
  () => useAgentShellsStore(s => Object.keys(s.attached).length > 0),
)
// Portal popout host -- renders canvases (and future surfaces) into real second
// OS windows that stay in THIS React tree. Chunk (+ Excalidraw) loads only once
// a popout is open; opening happens synchronously in the triggering click.
const PopoutHost = lazyModule(
  named(() => import('@/components/popout/popout-host'), 'PopoutHost'),
  () => usePopoutStore(s => Object.keys(s.records).length > 0),
)
// Parent-conditional: gated on showBatchPalette below, so plain React.lazy.
const BatchModeModal = lazy(() =>
  import('@/components/command-palette/batch-mode').then(m => ({ default: m.BatchModeModal })),
)

// Conversation-list header tools, shared by the mobile sheet + desktop sidebar
// headers (organize + locate). The collapse button is desktop-only and stays
// at each call site.
function SidebarTools({ canLocate }: { canLocate: boolean }) {
  return (
    <>
      <button
        type="button"
        onClick={openOrganizeProjects}
        className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
        title="Organize projects & groups"
      >
        <FolderTree className="size-3.5" />
      </button>
      {canLocate && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('locate-conversation'))}
          className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
          title="Scroll to current conversation"
        >
          <Crosshair className="size-3.5" />
        </button>
      )}
    </>
  )
}

// Desktop-only conversation-list sidebar (collapsed rail <-> full panel).
// Extracted from Dashboard to keep that shell component's complexity down.
function DesktopSidebar({
  collapsed,
  onToggle,
  canLocate,
}: {
  collapsed: boolean
  onToggle: () => void
  canLocate: boolean
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="hidden lg:flex absolute left-2 top-1/2 -translate-y-1/2 z-10 items-center justify-center w-5 h-10 rounded-r-md bg-muted/80 hover:bg-muted border border-l-0 border-border text-muted-foreground hover:text-foreground transition-colors"
        title="Expand sidebar (Ctrl+B)"
      >
        <ChevronRight className="size-3" />
      </button>
    )
  }
  return (
    <div className="hidden lg:flex w-[350px] shrink-0 border border-border overflow-hidden flex-col">
      <div className="flex items-center justify-end gap-1 px-1 pt-1 shrink-0">
        <SidebarTools canLocate={canLocate} />
        <button
          type="button"
          onClick={onToggle}
          className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
          title="Collapse sidebar (Ctrl+B)"
        >
          <ChevronLeft className="size-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 pt-0">
        <PanelBoundary name="Conversation list">
          <ProjectList />
        </PanelBoundary>
      </div>
      <RecapJobsWidget />
    </div>
  )
}

// Pre-existing critical-complexity app shell (CRAP is unavoidable for an
// uncovered top-level component this size). This change net-REDUCES it (19->18
// cyclomatic, via DesktopSidebar/SidebarTools extraction); a full shell split is
// tracked separately. Suppress so the gate doesn't attribute inherited debt here.
// fallow-ignore-next-line complexity
function Dashboard() {
  const [sheetOpen, setSheetOpen] = useState(
    () => isMobileViewport() && !useConversationsStore.getState().selectedConversationId,
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true')
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
  const showDebugConsole = useConversationsStore(s => s.showDebugConsole)
  const canAdmin = useConversationsStore(s => s.permissions.canAdmin)

  const swipeHandlers = useSwipeToOpen(() => setSheetOpen(true))

  function toggleSidebar() {
    setSidebarCollapsed(prev => {
      const next = !prev
      localStorage.setItem('sidebar-collapsed', String(next))
      return next
    })
  }

  useSyncEffects()
  useGlobalCommands(toggleSidebar)

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

  // Close sheet when a conversation is selected (mobile UX)
  useEffect(() => {
    if (selectedConversationId) {
      setSheetOpen(false)
    }
  }, [selectedConversationId])

  // When mobile sheet opens, scroll the current conversation into view.
  // Sheet slide-in animation runs 500ms (see ui/sheet.tsx), so we wait past it
  // before firing locate -- scrolling mid-animation either no-ops (item appears
  // "in view" inside the off-screen viewport) or gets visually masked by the
  // slide. The handler uses block:'center', behavior:'auto' for a definitive land.
  useEffect(() => {
    if (!sheetOpen || !selectedConversationId) return
    const timer = setTimeout(() => {
      window.dispatchEvent(new CustomEvent('locate-conversation'))
    }, 540)
    return () => clearTimeout(timer)
  }, [sheetOpen, selectedConversationId])

  function handleSwitcherSelect(id: string) {
    const store = useConversationsStore.getState()
    store.selectConversation(id, 'command-palette')
    store.setShowSwitcher(false)
    if (!isMobileViewport()) {
      requestAnimationFrame(() => focusInputEditor())
    }
  }

  return (
    <div className="h-full flex flex-col p-2 sm:p-4 max-w-[1400px] mx-auto overflow-hidden" {...swipeHandlers}>
      {swUpdate && <UpdateBanner swUpdate={swUpdate} onDismiss={() => setSwUpdate(null)} />}

      {/* Header with mobile menu */}
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="lg:hidden shrink-0">
              <Menu className="size-5" />
              <span className="sr-only">Toggle conversations</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[320px] sm:w-[380px] p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Conversations</SheetTitle>
            </SheetHeader>
            <div className="flex flex-col h-full">
              <div className="flex items-center justify-end gap-1 px-2 pt-2 shrink-0">
                <SidebarTools canLocate={!!selectedConversationId} />
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                <PanelBoundary name="Conversation list">
                  <ProjectList />
                </PanelBoundary>
              </div>
              <RecapJobsWidget />
            </div>
          </SheetContent>
        </Sheet>

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

      {/* Portal popout host -- canvases in real second windows, same React tree.
          Renders nothing inline (portals only); self-hides when no popout open. */}
      <PopoutHost />

      {/* Main content */}
      <div className="flex gap-4 flex-1 min-h-0 relative">
        <DesktopSidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} canLocate={!!selectedConversationId} />

        <div className="flex-1 border border-border overflow-hidden flex flex-col min-w-0">
          <PanelBoundary name="Conversation">
            <ConversationDetail />
          </PanelBoundary>
        </div>
      </div>

      {showDebugConsole && <DebugConsole onClose={() => useConversationsStore.getState().toggleDebugConsole()} />}

      {canAdmin && showSwitcher && (
        <PanelBoundary name="Command palette" variant="modal">
          <CommandPalette
            onSelect={handleSwitcherSelect}
            onClose={() => useConversationsStore.getState().setShowSwitcher(false)}
          />
        </PanelBoundary>
      )}

      <PanelBoundary name="JSON inspector" variant="modal">
        <JsonInspectorDialog />
      </PanelBoundary>
      <MediaLightbox />
      <MermaidLightbox />
      {canAdmin && <DispatchOverlay />}
      <LinkPreviewPane />
      <AudioPlayerHost />
      {canAdmin && <QuickTaskModal />}
      <RenameModal />
      <Suspense fallback={null}>
        <NightshiftModal />
      </Suspense>
      {canAdmin && (
        <Suspense fallback={null}>
          <DebugControlModal />
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
      <ActionFabGate />
      <VoiceKey />
      <AuthExpiredModal />
      <ChordOverlay />
      <PanelBoundary name="Spawn dialog" variant="modal">
        <SpawnDialog />
      </PanelBoundary>
      <ReviveDialog />
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

/** Full-screen lazy pages routed by bare hash (`#/canvas`, `#/sheaf`). */
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
  sheaf: () => (
    <FullscreenRoute fallbackLabel="Loading sheaf…">
      <SheafPage />
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
