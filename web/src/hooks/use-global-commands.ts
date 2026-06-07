import { useCallback, useEffect } from 'react'
import { openLaunchProfileManager } from '@/components/launch-profiles/manager-state'
import { openRecapConfigDialog } from '@/components/recap-jobs/recap-config-trigger'
import { openRecapHistory } from '@/components/recap-jobs/recap-history-trigger'
import { openRenameModal } from '@/components/rename-modal-trigger'
import { openManageChatConnections } from '@/components/settings/manage-chat-connections-trigger'
import { openManageProjectLinks } from '@/components/settings/manage-project-links-trigger'
import { openSpawnDialog } from '@/components/spawn-dialog-trigger'
import { openTerminateConfirm } from '@/components/terminate-confirm-trigger'
import { openTerminateLineageConfirm } from '@/components/terminate-lineage-confirm-trigger'
import { fetchTranscript, sendInput, useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { useShellsStore } from '@/hooks/use-shells'
import { formatShortcut, useChordCommand, useCommand, validateChordBindings } from '@/lib/commands'
import { canRespawnStaleDaemon } from '@/lib/daemon-control'
import { focusInputEditor } from '@/lib/focus-input'
import { openShell, projectShellCapable } from '@/lib/shell-commands'
import { toggleWebControl } from '@/lib/web-control-actions'
import { canShell, canTerminal, projectPath } from '@/lib/types'
import { isMobileViewport } from '@/lib/utils'

export function useGlobalCommands(toggleSidebar: () => void) {
  const openSwitcher = useCallback(() => {
    const store = useConversationsStore.getState()
    if (store.showTerminal) store.setShowTerminal(false)
    store.toggleSwitcher()
  }, [])

  const openCommandMode = useCallback(() => {
    const store = useConversationsStore.getState()
    if (store.showTerminal) store.setShowTerminal(false)
    store.openSwitcherWithFilter('>')
  }, [])

  useCommand('open-switcher', openSwitcher, {
    label: 'Command palette',
    shortcut: 'mod+p',
    group: 'Navigation',
  })

  useCommand('open-command-mode', openCommandMode, {
    label: 'Command palette (commands)',
    shortcut: 'mod+shift+p',
    group: 'Navigation',
  })

  useChordCommand('palette-via-chord', openSwitcher, {
    label: 'Command palette',
    key: 'k',
    group: 'Navigation',
  })

  useCommand(
    'toggle-verbose',
    () => {
      useConversationsStore.getState().toggleExpandAll()
    },
    { label: 'Toggle verbose / expand all', shortcut: 'mod+o', group: 'View' },
  )

  useCommand('toggle-sidebar', toggleSidebar, { label: 'Toggle sidebar', shortcut: 'mod+b', group: 'View' })

  useCommand(
    'open-sheaf',
    () => {
      window.location.hash = '/sheaf'
    },
    { label: 'Sheaf (24/48h fleet overview)', group: 'Navigation' },
  )

  useChordCommand(
    'toggle-debug',
    () => {
      useConversationsStore.getState().toggleDebugConsole()
    },
    { label: 'Toggle debug console', key: 'd', group: 'View' },
  )

  useCommand(
    'toggle-web-control',
    () => {
      const on = toggleWebControl()
      window.dispatchEvent(
        new CustomEvent('rclaude-toast', {
          detail: {
            title: 'Agent remote-control',
            body: on ? 'Enabled for this browser (1h). Agent can now drive it.' : 'Disabled.',
            variant: on ? 'warning' : 'info',
          },
        }),
      )
    },
    { label: 'Toggle agent remote-control (web debugger)', group: 'Debug' },
  )

  useCommand(
    'toggle-debug-direct',
    () => {
      useConversationsStore.getState().toggleDebugConsole()
    },
    { label: 'Toggle debug console', shortcut: 'ctrl+shift+d', group: 'View' },
  )

  useChordCommand(
    'toggle-tty',
    () => {
      const store = useConversationsStore.getState()
      if (store.showTerminal) {
        store.setShowTerminal(false)
        if (store.selectedConversationId) store.openTab(store.selectedConversationId, 'transcript')
      } else if (store.selectedConversationId) {
        const currentTab = store.requestedTab
        store.openTab(store.selectedConversationId, currentTab === 'tty' ? 'transcript' : 'tty')
      }
    },
    { label: 'Toggle terminal tab', key: 't', group: 'Navigation' },
  )

  useChordCommand(
    'fullscreen-terminal',
    () => {
      const store = useConversationsStore.getState()
      if (store.showTerminal) {
        store.setShowTerminal(false)
        if (store.selectedConversationId) store.openTab(store.selectedConversationId, 'transcript')
      } else {
        const conversation = store.selectedConversationId
          ? store.conversationsById[store.selectedConversationId]
          : undefined
        if (conversation && canTerminal(conversation) && conversation.connectionIds?.[0]) {
          store.openTerminal(conversation.connectionIds[0])
        }
      }
    },
    { label: 'Toggle fullscreen terminal', key: 'f', group: 'Navigation' },
  )

  useChordCommand(
    'spawn-conversation',
    () => {
      useConversationsStore.getState().openSwitcherWithFilter('S:~/')
    },
    { label: 'Spawn new conversation', key: 's', group: 'Conversation' },
  )

  // Open a host shell on the selected conversation's sentinel + project path.
  // PLAN spec'd "Cmd+G S", but `s` is already the spawn-conversation chord;
  // bound to `h` (host shell) to avoid clobbering existing muscle memory. The
  // dock (conversation-independent) is the primary surface; this is the
  // keyboard fast-path. Gated on the host sentinel's `features.shell`.
  //
  // The host shell is a SENTINEL feature, not an agent-host one -- so it works
  // with NO conversation too: on a project view, fall back to the selected
  // project's URI (no conversationId), gated on that sentinel's shellCapable.
  useChordCommand(
    'open-shell',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      const conversation = sid ? store.conversationsById[sid] : undefined
      if (conversation && canShell(conversation)) {
        const shellId = openShell({
          projectUri: conversation.project,
          cols: 80,
          rows: 24,
          conversationId: sid ?? undefined,
        })
        // Maximize the moment the broker echoes it into the roster (one tick
        // later). ShellDock watches autoExpandId and expands + clears it.
        useShellsStore.getState().setAutoExpandId(shellId)
        return
      }
      // Conversation-free path: a project is selected on a shell-capable sentinel.
      const projectUri = store.selectedProjectUri
      if (!projectUri || !projectShellCapable(store.sentinels, projectUri)) return
      const shellId = openShell({ projectUri, cols: 80, rows: 24 })
      useShellsStore.getState().setAutoExpandId(shellId)
    },
    {
      label: 'Open host shell',
      key: '.',
      group: 'Navigation',
      when: () => {
        const store = useConversationsStore.getState()
        const sid = store.selectedConversationId
        const conversation = sid ? store.conversationsById[sid] : undefined
        if (conversation && canShell(conversation)) return true
        const projectUri = store.selectedProjectUri
        return !!projectUri && projectShellCapable(store.sentinels, projectUri)
      },
    },
  )

  useChordCommand(
    'launch-conversation',
    () => {
      const store = useConversationsStore.getState()
      const conversation = store.selectedConversationId
        ? store.conversationsById[store.selectedConversationId]
        : undefined
      const projectUri = conversation?.project ?? store.selectedProjectUri ?? undefined
      const spawnPath = conversation
        ? projectPath(conversation.project) || store.controlPanelPrefs.defaultConversationCwd
        : projectPath(store.selectedProjectUri ?? '') || store.controlPanelPrefs.defaultConversationCwd
      openSpawnDialog({ path: spawnPath || '~', projectUri })
    },
    { label: 'Launch conversation', key: 'l', group: 'Conversation' },
  )

  useChordCommand(
    'terminate-conversation',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const conversation = store.conversationsById[sid]
      if (!conversation || conversation.status === 'ended') return
      const name = conversation.title || conversation.agentName || null
      openTerminateConfirm(sid, name)
    },
    { label: 'Terminate conversation', key: 'x', group: 'Conversation' },
  )

  useCommand(
    'terminate-lineage',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      // Only meaningful when the selected conversation has spawned descendants.
      if (!store.conversations.some((c: { parentConversationId?: string }) => c.parentConversationId === sid)) return
      openTerminateLineageConfirm(sid)
    },
    {
      label: 'Terminate full lineage',
      group: 'Conversation',
      when: () => {
        const store = useConversationsStore.getState()
        const sid = store.selectedConversationId
        return (
          !!sid && store.conversations.some((c: { parentConversationId?: string }) => c.parentConversationId === sid)
        )
      },
    },
  )

  useCommand(
    'rename-conversation',
    () => {
      if (useConversationsStore.getState().selectedConversationId) {
        openRenameModal()
      }
    },
    { label: 'Rename conversation', shortcut: 'ctrl+shift+r', group: 'Conversation' },
  )

  useChordCommand(
    'reload-transcript',
    async () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const cached = store.transcripts[sid]?.length ?? 0
      console.log(`[reload] manual reload ${sid.slice(0, 8)}: cached=${cached}`)
      const result = await fetchTranscript(sid)
      if (!result) {
        console.log(`[reload] ${sid.slice(0, 8)}: fetch failed`)
        return
      }
      console.log(`[reload] ${sid.slice(0, 8)}: got ${result.entries.length} entries lastSeq=${result.lastSeq}`)
      useConversationsStore.getState().setTranscript(sid, result.entries)
      // Also force a virtualizer rect re-read: if the transcript was stuck
      // rendering empty (collapsed scrollRect), refetching data alone won't
      // recover it -- the viewport measurement has to be re-pushed too.
      useConversationsStore.getState().requestTranscriptRemeasure()
    },
    { label: 'Reload current transcript', key: 'u', group: 'Conversation' },
  )

  useChordCommand(
    'rename-conversation-chord',
    () => {
      if (useConversationsStore.getState().selectedConversationId) {
        openRenameModal()
      }
    },
    { label: 'Rename conversation', key: 'r', group: 'Conversation' },
  )

  useChordCommand(
    'search-tasks',
    () => {
      useConversationsStore.getState().openSwitcherWithFilter('@')
    },
    { label: 'Search tasks', key: '/', group: 'Navigation' },
  )

  useChordCommand(
    'open-project',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const conversation = store.conversationsById[sid]
      if (conversation && conversation.status !== 'ended') {
        store.openTab(sid, 'project')
      }
    },
    { label: 'Open project board', key: 'p', group: 'Navigation' },
  )

  const goHome = useCallback(() => {
    if (isMobileViewport()) return
    const store = useConversationsStore.getState()
    if (store.showSwitcher || store.showDebugConsole || store.showTerminal) return
    if (!store.selectedConversationId) return
    store.selectSubagent(null)
    store.openTab(store.selectedConversationId, 'transcript')
    requestAnimationFrame(() => focusInputEditor())
  }, [])

  useCommand('go-home', goHome, {
    label: 'Go to transcript + focus input',
    shortcut: 'Escape',
    group: 'Navigation',
  })

  useChordCommand('go-home-chord', goHome, {
    label: 'Go to transcript',
    key: 'Space',
    group: 'Navigation',
  })

  useChordCommand(
    'toggle-ended-conversations',
    () => {
      const store = useConversationsStore.getState()
      store.updateControlPanelPrefs({ showEndedConversations: !store.controlPanelPrefs.showEndedConversations })
    },
    { label: 'Toggle show ended conversations', key: 'e', group: 'View' },
  )

  useCommand(
    'toggle-scrollback-reservation',
    () => {
      const store = useConversationsStore.getState()
      store.updateControlPanelPrefs({ scrollbackReservation: !store.controlPanelPrefs.scrollbackReservation })
    },
    { label: 'Toggle scrollback reservation (experimental)', group: 'View' },
  )

  useCommand(
    'interrupt',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const conversation = store.conversationsById[sid]
      if (conversation && conversation.status !== 'ended') {
        wsSend('send_interrupt', { conversationId: sid })
      }
    },
    { label: 'Interrupt current turn', shortcut: 'Escape Escape', group: 'Conversation' },
  )

  useCommand(
    'respawn-stale-daemon',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const conversation = store.conversationsById[sid]
      // Daemon-only -- routes the cc-daemon `respawn-stale` op at a
      // sleep/wake-stale worker; a no-op for any other backend.
      if (canRespawnStaleDaemon(conversation)) {
        wsSend('daemon_respawn_stale', { conversationId: sid })
      }
    },
    { label: 'Respawn stale daemon worker', group: 'Conversation' },
  )

  useCommand(
    'switch-conversation',
    () => {
      const { conversationMru, conversations, selectConversation } = useConversationsStore.getState()
      const prev = conversationMru.slice(1).find((id: string) => conversations.some((s: { id: string }) => s.id === id))
      if (prev) selectConversation(prev, 'ctrl-tab')
    },
    { label: 'Switch to previous conversation', shortcut: 'ctrl+Tab', group: 'Navigation' },
  )

  const keepMicOpen = useConversationsStore(
    (s: { controlPanelPrefs: { keepMicOpen: boolean } }) => s.controlPanelPrefs.keepMicOpen,
  )
  useCommand(
    'toggle-keep-mic-open',
    () => {
      const store = useConversationsStore.getState()
      const next = !store.controlPanelPrefs.keepMicOpen
      store.updateControlPanelPrefs({ keepMicOpen: next })
      if (next) {
        import('@/hooks/use-voice-recording').then(m => m.prewarmMicStream())
      }
    },
    { label: keepMicOpen ? 'Keep mic open: ON (disable)' : 'Keep mic open: OFF (enable)', group: 'Voice' },
  )

  useCommand(
    'clear-reload',
    async () => {
      const { clearCacheAndReload } = await import('@/lib/utils')
      clearCacheAndReload()
    },
    { label: 'Clear cache & reload', group: 'System' },
  )

  useCommand('settings', () => window.dispatchEvent(new Event('open-settings')), { label: 'Settings', group: 'System' })

  useCommand('theme', () => {}, { label: 'Theme', group: 'System', submenu: 'theme:' })

  useCommand('manage-users', () => window.dispatchEvent(new Event('open-user-admin')), {
    label: 'Manage users',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canEditUsers,
  })

  useCommand('open-batch-operations', () => window.dispatchEvent(new Event('open-batch-palette')), {
    label: 'Batch operations',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canAdmin,
  })

  useChordCommand(
    'batch-operations-chord',
    () => {
      if (!useConversationsStore.getState().permissions.canAdmin) return
      window.dispatchEvent(new Event('open-batch-palette'))
    },
    {
      label: 'Batch operations',
      key: 'b',
      group: 'System',
      when: () => useConversationsStore.getState().permissions.canAdmin,
    },
  )

  useCommand('manage-sentinels', () => window.dispatchEvent(new Event('open-sentinel-manager')), {
    label: 'Manage sentinels',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canAdmin,
  })

  useCommand('manage-gateways', () => window.dispatchEvent(new Event('open-gateway-manager')), {
    label: 'Manage Hermes connections',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canAdmin,
  })

  useCommand('manage-search-index', () => window.dispatchEvent(new Event('open-search-index')), {
    label: 'Manage search index',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canAdmin,
  })

  useCommand('manage-chat-connections', () => openManageChatConnections(), {
    label: 'Manage chat connections',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canAdmin,
  })

  useCommand('manage-launch-profiles', () => openLaunchProfileManager(), {
    label: 'Manage Launch Profiles',
    group: 'Launch',
  })

  // ─── Recap commands ───────────────────────────────────────────────────
  // Resolves the "this project" target for project-scoped recaps. Falls back
  // to '*' (cross-project) when no conversation is selected.
  function selectedProjectOrCross(): string {
    const sid = useConversationsStore.getState().selectedConversationId
    const conversations = useConversationsStore.getState().conversations
    const selected = conversations.find((s: { id: string; project?: string }) => s.id === sid)
    return selected?.project ?? '*'
  }

  useCommand('recap-project', () => openRecapConfigDialog({ projectUri: selectedProjectOrCross() }), {
    label: 'Project recap…',
    group: 'Recap',
  })
  useCommand('recap-all-projects', () => openRecapConfigDialog({ projectUri: '*' }), {
    label: 'Recap all projects…',
    group: 'Recap',
  })
  useCommand('recap-view-all', () => openRecapHistory(), {
    label: 'View recaps',
    group: 'Recap',
  })

  useCommand(
    'manage-project-links',
    () => {
      const sid = useConversationsStore.getState().selectedConversationId
      const conversations = useConversationsStore.getState().conversations
      const selected = conversations.find((s: { id: string; project?: string }) => s.id === sid)
      openManageProjectLinks(selected?.project)
    },
    { label: 'Manage project links', group: 'System' },
  )

  useCommand(
    'effort',
    (level = 'medium') => {
      const sid = useConversationsStore.getState().selectedConversationId
      if (sid) sendInput(sid, `/effort ${level}`)
    },
    { label: 'Set effort level', group: 'Conversation' },
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      const conflicts = validateChordBindings()
      for (const c of conflicts) {
        const longer = c.longerChords.map(l => formatShortcut(l.shortcut)).join(', ')
        window.dispatchEvent(
          new CustomEvent('rclaude-toast', {
            detail: {
              title: 'CHORD CONFLICT',
              body: `"${c.bindingLabel}" (${formatShortcut(c.binding)}) is also a prefix of: ${longer} -- it will only fire on timeout`,
              variant: 'warning',
            },
          }),
        )
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [])
}
