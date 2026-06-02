import { ChevronLeft, ChevronRight, Command, Crosshair, FileText, Menu } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { ActionFab } from '@/components/action-fab'
import { AuthExpiredModal } from '@/components/auth-expired-modal'
import { AuthGate } from '@/components/auth-gate'
import { ChordOverlay } from '@/components/chord-overlay'
import { CommandPalette } from '@/components/command-palette'
import { BatchModeModal } from '@/components/command-palette/batch-mode'
import { ConversationDetail } from '@/components/conversation-detail'
import { DebugConsole } from '@/components/debug-console'
import { Header } from '@/components/header'
import { JsonInspectorDialog } from '@/components/json-inspector'
import { LaunchProfileCommands } from '@/components/launch-profiles/launch-profile-commands'
import { LaunchToastContainer } from '@/components/launch-profiles/launch-toast'
import { LaunchProfileManager } from '@/components/launch-profiles/manager'
import { MarkdownViewerModal } from '@/components/markdown-viewer-modal'
import { MediaLightbox } from '@/components/media-lightbox'
import { ProjectList } from '@/components/project-list'
import { quickTaskBus } from '@/components/quick-task-trigger'
import { PublicRecapView } from '@/components/recap/public-recap-view'
import { recapOpenBus } from '@/components/recap/recap-open-trigger'
import { recapConfigBus } from '@/components/recap-jobs/recap-config-trigger'
import { recapHistoryBus } from '@/components/recap-jobs/recap-history-trigger'
import { RecapJobsWidget } from '@/components/recap-jobs/recap-jobs-widget'
import { DebugControlModal } from '@/components/debug/debug-control-modal'
import { renameModalBus } from '@/components/rename-modal-trigger'
import { reviveDialogBus } from '@/components/revive-dialog-trigger'
import { manageChatConnectionsBus } from '@/components/settings/manage-chat-connections-trigger'
import { manageProjectLinksBus } from '@/components/settings/manage-project-links-trigger'
import { SharedConversationView } from '@/components/shared-conversation-view'
import { ShortcutHelp } from '@/components/shortcut-help'
import { spawnDialogBus } from '@/components/spawn-dialog-trigger'
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

const WebTerminal = lazy(() => import('@/components/web-terminal').then(m => ({ default: m.WebTerminal })))
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
const RenameModal = lazyModule(
  named(() => import('@/components/rename-modal'), 'RenameModal'),
  renameModalBus.useArmed,
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
              {selectedConversationId && (
                <div className="flex items-center justify-end px-2 pt-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new CustomEvent('locate-conversation'))}
                    className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
                    title="Scroll to current conversation"
                  >
                    <Crosshair className="size-3.5" />
                  </button>
                </div>
              )}
              <div className="flex-1 overflow-y-auto p-2">
                <ProjectList />
              </div>
              <RecapJobsWidget />
            </div>
          </SheetContent>
        </Sheet>

        <div className="flex-1">
          <Header />
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

      {/* Main content */}
      <div className="flex gap-4 flex-1 min-h-0 relative">
        {sidebarCollapsed ? (
          <button
            type="button"
            onClick={toggleSidebar}
            className="hidden lg:flex absolute left-2 top-1/2 -translate-y-1/2 z-10 items-center justify-center w-5 h-10 rounded-r-md bg-muted/80 hover:bg-muted border border-l-0 border-border text-muted-foreground hover:text-foreground transition-colors"
            title="Expand sidebar (Ctrl+B)"
          >
            <ChevronRight className="size-3" />
          </button>
        ) : (
          <div className="hidden lg:flex w-[350px] shrink-0 border border-border overflow-hidden flex-col">
            <div className="flex items-center justify-end px-1 pt-1 shrink-0">
              {selectedConversationId && (
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('locate-conversation'))}
                  className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
                  title="Scroll to current conversation"
                >
                  <Crosshair className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={toggleSidebar}
                className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
                title="Collapse sidebar (Ctrl+B)"
              >
                <ChevronLeft className="size-3.5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2 pt-0">
              <ProjectList />
            </div>
            <RecapJobsWidget />
          </div>
        )}

        <div className="flex-1 border border-border overflow-hidden flex flex-col min-w-0">
          <ConversationDetail />
        </div>
      </div>

      {showDebugConsole && <DebugConsole onClose={() => useConversationsStore.getState().toggleDebugConsole()} />}

      {canAdmin && showSwitcher && (
        <CommandPalette
          onSelect={handleSwitcherSelect}
          onFileSelect={(convId, path) => {
            const store = useConversationsStore.getState()
            store.selectConversation(convId)
            store.setShowSwitcher(false)
            store.openTab(convId, 'files')
            store.setPendingFilePath(path)
          }}
          onClose={() => useConversationsStore.getState().setShowSwitcher(false)}
        />
      )}

      <JsonInspectorDialog />
      <MediaLightbox />
      {canAdmin && <QuickTaskModal />}
      <RenameModal />
      {canAdmin && <DebugControlModal />}
      <MarkdownViewerModal />
      {canAdmin && <TaskBatchSelector />}
      {canAdmin && <ShortcutHelp />}
      {canAdmin && <BatchModeModal open={showBatchPalette} onClose={() => setShowBatchPalette(false)} />}

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
      <VoiceFabGate />
      <ActionFabGate />
      <VoiceKey />
      <AuthExpiredModal />
      <ChordOverlay />
      <SpawnDialog />
      <ReviveDialog />
      <RecapConfigDialog />
      <RecapViewer />
      <RecapHistoryModal />
      <ManageProjectLinksDialog />
      <ManageChatConnectionsDialog />
      <LaunchProfileManager />
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

export function App() {
  const hash = useHash()

  // Phase 11: /r/:token redirected here as ?share=TOKEN&kind=recap. The SPA
  // serves a standalone public recap viewer (no project chrome, no auth gate).
  const shareToken = detectShareMode()
  if (shareToken && detectShareKind() === 'recap') {
    return <PublicRecapView token={shareToken} />
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

  if (hash === '/sheaf' || hash === 'sheaf') {
    return (
      <AuthGate>
        <Suspense
          fallback={
            <div className="fixed inset-0 flex items-center justify-center text-muted-foreground">Loading sheaf…</div>
          }
        >
          <SheafPage />
        </Suspense>
      </AuthGate>
    )
  }

  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}
