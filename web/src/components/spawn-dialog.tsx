import { projectIdentityKey } from '@shared/project-uri'
/**
 * Spawn Dialog - Pre-spawn configuration + launch monitor
 *
 * Phase 1 (config): Configure model, effort, mode, etc.
 * Phase 2 (launching): Step-by-step progress via shared LaunchMonitor.
 */

import type { ChatApiConnection } from '@shared/chat-api-types'
import type { CcSessionEntry, ProfileUsageSnapshot } from '@shared/protocol'
import { buildSpawnDiagnostics } from '@shared/spawn-diagnostics'
import { OPENCODE_TOOL_PERMISSION_OPTIONS, type OpenCodeToolPermission, type SpawnRequest } from '@shared/spawn-schema'
import { ChevronDown, GitBranch, Zap } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  OPENCODE_CURATED_VALUES,
  OPENCODE_CUSTOM_SENTINEL,
  OPENCODE_DEFAULT_SENTINEL,
  OPENCODE_GO_MODELS,
  OPENCODE_ZEN_MODELS,
} from '@/components/spawn-dialog/opencode-models'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import {
  type ProjectSettingsMap,
  updateProjectSettings,
  useConversationsStore,
  wsSend,
} from '@/hooks/use-conversations'
import type { DaemonRosterEntry } from '@/hooks/use-daemon-roster'
import { useLaunchProgress } from '@/hooks/use-launch-progress'
import { parseEnvText } from '@/lib/env-parse'
import { useKeyLayer } from '@/lib/key-layers'
import { cwdToProjectUri } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { detectWorktree } from '@/lib/worktree-path'
import { _spawnDialogBus, type SpawnDialogOptions } from './spawn-dialog-trigger'
import { LaunchConfigFields, type LaunchFieldsValue } from './launch-config-fields'
import { LaunchDialogBottom } from './launch-monitor'
import { putLaunchProfiles } from './launch-profiles/api'
import { blankProfile } from './launch-profiles/draft'
import { openLaunchProfileManager } from './launch-profiles/manager-state'
import { ProfileDropdown } from './launch-profiles/profile-dropdown'
import { applyProfileToForm, formSnapshotToProfileSpawn } from './launch-profiles/spawn-dialog-apply'
import { useLaunchProfiles } from './launch-profiles/use-launch-profiles'
import { type BackendKind, BackendSelect } from './spawn-dialog/backend-select'
import { blankDaemonForm, type DaemonMode, type DaemonModeFormValue } from './spawn-dialog/daemon-launch'
import { DaemonModePanel } from './spawn-dialog/daemon-mode-panel'
import { DaemonRosterBrowser } from './spawn-dialog/daemon-roster-browser'
import {
  type ClaudeTransport,
  deriveClaudeTransport,
  isClaudeFamilyBackend,
  processModelToState,
} from './spawn-dialog/process-model'
import { ProcessModelSegmented } from './spawn-dialog/process-model-segmented'
import { SentinelProfileRadio } from './spawn-dialog/sentinel-profile-radio'
import { useSpawnAction } from './spawn-dialog/use-spawn-action'

/** Mirrors src/broker/backends/opencode.ts deriveOpenCodeSlug -- needed
 *  client-side so the dialog can look up project settings under the same
 *  `opencode://{slug}` URI the broker keys on. Keep in sync. */
function deriveOpenCodeSlug(model: string | undefined): string {
  if (!model) return 'default'
  const tail = model.split('/').pop() || model
  const provider = model.split('/')[0]
  const base = provider && provider !== tail ? `${provider}-${tail}` : tail
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  )
}

interface HermesGateway {
  gatewayId: string
  alias: string
  gatewayType: string
  label?: string
  connected: boolean
}

interface SpawnDialogState {
  open: boolean
  options: SpawnDialogOptions | null
}

export function SpawnDialog() {
  const [state, setState] = useState<SpawnDialogState>({ open: false, options: null })
  const [headless, setHeadless] = useState(true)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [agent, setAgent] = useState('')
  const [bare, setBare] = useState(false)
  const [repl, setRepl] = useState(false)
  const [useWorktree, setUseWorktree] = useState(false)
  const [worktreeName, setWorktreeName] = useState('')
  // When the launch trigger path lives under `.../<project>/.claude/worktrees/<name>`
  // we default the launch CWD to the MAIN project path and surface a nudge to
  // opt back into the worktree. `useWorktreePath` is the toggle, reset on every
  // `_openDialog` -- intentionally not sticky (the nudge exists to surface the
  // choice; remembering it defeats the point).
  const [useWorktreePath, setUseWorktreePath] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [autocompactPct, setAutocompactPct] = useState<number | ''>('')
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('')
  const [includePartialMessages, setIncludePartialMessages] = useState(true)
  const [configTab, setConfigTab] = useState<'basic' | 'advanced'>('basic')
  const [resumeId, setResumeId] = useState('')
  const [envText, setEnvText] = useState('')
  const [backend, setBackend] = useState<BackendKind>('claude')
  // The daemon process model (`claude-daemon` transport) for the claude family.
  // Orthogonal to `headless` (PTY vs stream-json); together they derive the
  // claude transport. Only meaningful when `backend` is the claude family.
  const [isDaemon, setIsDaemon] = useState(false)
  // Daemon launch state (only meaningful when `isDaemon`).
  const [daemonMode, setDaemonMode] = useState<DaemonMode>('new')
  const [daemonForm, setDaemonForm] = useState<DaemonModeFormValue>(blankDaemonForm)
  const [daemonAttach, setDaemonAttach] = useState<DaemonRosterEntry | null>(null)
  const [daemonErrors, setDaemonErrors] = useState<string[]>([])
  const [chatConnectionId, setChatConnectionId] = useState('')
  const [chatConnections, setChatConnections] = useState<ChatApiConnection[]>([])
  const [hermesGateways, setHermesGateways] = useState<HermesGateway[]>([])
  const [hermesGatewayId, setHermesGatewayId] = useState('')
  // OpenCode-specific: model identifier in the OpenCode provider/model format
  // (e.g. "openrouter/anthropic/claude-haiku-4.5"). Optional -- empty string
  // sends `undefined` to the broker and OpenCode uses its own configured
  // default. Common picks are exposed via a dropdown (OpenCode Go + Zen);
  // power users can pick "Custom..." to type any of OpenCode's 200+ models.
  const [openCodeModel, setOpenCodeModel] = useState('')
  // Tracks whether the user picked "Custom..." in the model dropdown. When
  // true, the free-text input replaces the dropdown.
  const [openCodeModelCustom, setOpenCodeModelCustom] = useState(false)
  // OpenCode tool permission tier. Defaults to 'safe' (read-only); project
  // settings can override this default per-project. The dropdown lives in the
  // OpenCode tab next to the model field.
  const [openCodeToolPermission, setOpenCodeToolPermission] = useState<OpenCodeToolPermission>('safe')
  const [profileId, setProfileId] = useState<string | undefined>()
  /** Sentinel-profile selection -- either a literal profile NAME (Fixed mode)
   *  or a SelectionMode token (`default` | `balanced` | `random`). Empty
   *  string falls back to the sentinel's `defaultSelection`. Wire field name:
   *  `SpawnRequest.profile`. */
  const [sentinelProfile, setSentinelProfile] = useState<string>('')
  /** Sentinel-pool selection for Balanced/Random launches. Empty string =
   *  use the sentinel's `defaultPool`. Wire field: `SpawnRequest.pool`. */
  const [sentinelPool, setSentinelPool] = useState<string>('')
  const [phase, setPhase] = useState<'config' | 'launching'>('config')
  const [savedFeedback, setSavedFeedback] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [conversationId, setWrapperId] = useState<string | null>(null)
  // Track which conversation was selected when spawn started -- don't yank the user
  // back to the spawned conversation if they navigated away during the countdown
  const conversationAtSpawnRef = useRef<string | null>(null)

  const projectSettings = useConversationsStore((s: { projectSettings: ProjectSettingsMap }) => s.projectSettings)
  const globalSettings = useConversationsStore((s: { globalSettings: Record<string, unknown> }) => s.globalSettings)
  // Connected sentinels with their reported profiles + defaultSelection.
  // Used by the Sentinel-profile radio (Phase 6) to know which profiles to
  // offer for the target sentinel. NAMES + display only (Profile-Env Boundary).
  const sentinelStatuses = useConversationsStore(s => s.sentinels)
  const profileUsage = useConversationsStore(s => s.profileUsage)
  const { profiles: launchProfiles } = useLaunchProfiles()
  const launchProfilesRef = useRef(launchProfiles)
  launchProfilesRef.current = launchProfiles

  // Shared launch progress hook
  const progress = useLaunchProgress({
    jobId,
    conversationId,
    timeoutMs: 60_000,
    enabled: phase === 'launching',
  })

  // Register the open callback
  const progressReset = progress.reset
  useEffect(() => {
    _spawnDialogBus.open = (options: SpawnDialogOptions) => {
      // Settings are project-scoped, not worktree-scoped: when the trigger
      // path is inside `.claude/worktrees/<name>`, normalize the lookup to
      // the main project so worktree launches inherit the project's saved
      // defaults. Save-side normalizes the same way.
      const settingsPath = detectWorktree(options.path)?.mainPath ?? options.path
      setUseWorktreePath(false)
      const ps = projectSettings[projectIdentityKey(cwdToProjectUri(settingsPath))]
      const gs = globalSettings as Record<string, unknown>
      // Resolve defaults: project > global > hardcoded
      const defaultMode = ps?.defaultLaunchMode || (gs.defaultLaunchMode as string) || 'headless'
      setHeadless(defaultMode !== 'pty')
      setModel('')
      setEffort('')
      setAgent('')
      setBare(ps?.defaultBare ?? (gs.defaultBare as boolean) ?? false)
      setRepl(ps?.defaultRepl ?? (gs.defaultRepl as boolean) ?? false)
      setUseWorktree(false)
      setWorktreeName('')
      setName('')
      setDescription('')
      const pm = ps?.defaultPermissionMode || (gs.defaultPermissionMode as string) || 'default'
      setPermissionMode(pm === 'default' ? '' : pm)
      const acp = ps?.defaultAutocompactPct ?? (gs.defaultAutocompactPct as number) ?? 0
      setAutocompactPct(acp > 0 ? acp : '')
      const budget = ps?.defaultMaxBudgetUsd ?? (gs.defaultMaxBudgetUsd as number) ?? 0
      setMaxBudgetUsd(budget > 0 ? String(budget) : '')
      const envDefault = ps?.defaultEnvText || (gs.defaultEnvText as string) || ''
      setResumeId('')
      setEnvText(envDefault)
      setIncludePartialMessages(
        ps?.defaultIncludePartialMessages ?? (gs.defaultIncludePartialMessages as boolean) ?? true,
      )
      // Default backend follows the source project URI scheme: `opencode://`
      // projects open with the OpenCode backend pre-selected. Other schemes
      // (claude://, hermes://, etc.) start on Claude and let the user pick.
      setBackend(options.projectUri?.startsWith('opencode://') ? 'opencode' : 'claude')
      setIsDaemon(false)
      setDaemonMode('new')
      setDaemonForm(blankDaemonForm())
      setDaemonAttach(null)
      setDaemonErrors([])
      setChatConnectionId('')
      setHermesGateways([])
      setHermesGatewayId('')
      // Resolve initial OpenCode model: source-project default > global default >
      // hardcoded fallback. Mirrors src/shared/opencode-config.ts
      // resolveOpenCodeModel + OPENCODE_FALLBACK_MODEL so the dashboard pre-fill
      // matches what the broker would have picked anyway.
      const initialOpenCodeModel =
        (ps?.defaultOpenCodeModel as string | undefined)?.trim() ||
        (gs.defaultOpenCodeModel as string | undefined)?.trim() ||
        'opencode-go/glm-5.1'
      setOpenCodeModel(initialOpenCodeModel)
      setOpenCodeModelCustom(!OPENCODE_CURATED_VALUES.has(initialOpenCodeModel))
      // Default tier from the saved opencode://{slug} project (the same URI
      // the broker keys on). Falls back to 'safe' so we never silently grant
      // bash/write/edit on a fresh project.
      const opencodeProjectUri = `opencode://${deriveOpenCodeSlug(initialOpenCodeModel)}`
      const ocPs = projectSettings[projectIdentityKey(opencodeProjectUri)]
      setOpenCodeToolPermission((ocPs?.defaultOpenCodeToolPermission ?? 'safe') as OpenCodeToolPermission)
      setConfigTab('basic')
      setSavedFeedback(null)
      setPhase('config')
      setJobId(null)
      setWrapperId(null)
      const initialProfile = options.profileId
        ? launchProfilesRef.current.find(p => p.id === options.profileId)
        : undefined
      setProfileId(initialProfile?.id)
      // Sentinel-profile pre-selection from URI / shorthand. The launch
      // profile's saved sentinel-profile (if any) takes precedence and is
      // applied by `applyProfileToForm` below. Profile and pool are mutually
      // exclusive at the wire layer; the dialog keeps both fields for UI
      // ergonomics but only one ends up on the spawn request.
      setSentinelProfile(options.profile ?? '')
      setSentinelPool(options.pool ?? '')
      if (initialProfile) {
        applyProfileToForm(initialProfile, {
          setHeadless,
          setModel,
          setEffort,
          setAgent,
          setBare,
          setRepl,
          setPermissionMode,
          setAutocompactPct,
          setMaxBudgetUsd,
          setIncludePartialMessages,
          setBackend,
          setEnvText,
          setOpenCodeModel,
          setOpenCodeToolPermission,
          setIsDaemon,
          setDaemonMode,
          setDaemonForm,
          setSentinelProfile,
          setSentinelPool,
        })
      }
      // Fetch chat connections + gateway availability
      fetch(`${window.location.protocol}//${window.location.host}/api/chat/connections`)
        .then(r => (r.ok ? r.json() : { connections: [] }))
        .then(d => setChatConnections(d.connections || []))
        .catch(() => setChatConnections([]))
      fetch(`${window.location.protocol}//${window.location.host}/api/gateways`)
        .then(r => (r.ok ? r.json() : []))
        .then(gws => {
          if (!Array.isArray(gws)) return setHermesGateways([])
          const hermesOnes = (gws as HermesGateway[]).filter(g => g.gatewayType === 'hermes')
          setHermesGateways(hermesOnes)
          // Auto-select when exactly one is connected (matches "default to single one" requirement)
          const connectedOnes = hermesOnes.filter(g => g.connected)
          if (connectedOnes.length === 1) setHermesGatewayId(connectedOnes[0].gatewayId)
        })
        .catch(() => setHermesGateways([]))
      // Drop any stale error/steps from a prior failed launch so reopening
      // the dialog doesn't show the old "Conversation failed to connect" banner.
      progressReset()
      setState({ open: true, options })
    }
    return () => {
      _spawnDialogBus.open = null
    }
  }, [projectSettings, globalSettings, progressReset])

  // Add "Conversation connected" step when conversation connects
  const addedConnectedStepRef = useRef(false)
  useEffect(() => {
    if (!progress.isConnected || addedConnectedStepRef.current) return
    addedConnectedStepRef.current = true
    progress.setSteps(prev => [
      ...prev,
      {
        label: 'Conversation connected',
        status: 'done',
        ts: Date.now(),
        detail: (progress.launch.conversationId || progress.spawnedConversation?.id || '').slice(0, 8),
      },
    ])
  }, [progress.isConnected, progress.launch.conversationId, progress.spawnedConversation?.id, progress.setSteps])

  const handleClose = useCallback(() => {
    addedConnectedStepRef.current = false
    const currentId = useConversationsStore.getState().selectedConversationId
    const userNavigatedAway = currentId !== conversationAtSpawnRef.current && currentId !== null
    const sid =
      progress.launch.conversationId ||
      (progress.spawnedConversation && progress.spawnedConversation.status !== 'ended'
        ? progress.spawnedConversation.id
        : null)

    if (sid && !userNavigatedAway) {
      useConversationsStore.getState().selectConversation(sid, 'spawn-dialog-close')
    } else if (sid && userNavigatedAway) {
      console.log(
        `[nav] spawn-dialog: NOT switching to ${sid.slice(0, 8)} -- user navigated to ${currentId?.slice(0, 8)} during spawn`,
      )
    }
    setState({ open: false, options: null })
    setJobId(null)
  }, [progress.launch.conversationId, progress.spawnedConversation?.id, progress.spawnedConversation?.status])

  // Auto-redirect when countdown reaches 0
  useEffect(() => {
    if (progress.viewCountdown !== 0) return
    handleClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once when countdown hits 0, not on every handleClose recreation
  }, [progress.viewCountdown])

  /** Explicitly navigate to the spawned conversation and close. */
  const handleViewConversation = useCallback(() => {
    const sid = progress.launch.conversationId || progress.spawnedConversation?.id
    if (sid) useConversationsStore.getState().selectConversation(sid, 'spawn-dialog-view-conversation')
    progress.setViewCountdown(null)
    setState({ open: false, options: null })
    setJobId(null)
  }, [progress.launch.conversationId, progress.spawnedConversation, progress.setViewCountdown])

  // Derived claude "Process model" (transport). The daemon is not a backend --
  // it is the third claude process model, tracked by the orthogonal `isDaemon`
  // flag alongside `headless` (PTY vs stream-json). The transport drives the
  // daemon-specific UI gate and is written to the spawn request.
  const transport: ClaudeTransport = deriveClaudeTransport(isDaemon, headless)
  const showProcessModel = isClaudeFamilyBackend(backend)
  const isDaemonTransport = showProcessModel && transport === 'claude-daemon'
  const setProcessModel = useCallback(
    (pm: ClaudeTransport) => {
      const next = processModelToState(pm, headless)
      setIsDaemon(next.isDaemon)
      setHeadless(next.headless)
      haptic('tap')
    },
    [headless],
  )

  // Worktree-aware launch path. When the source path lives under
  // `.../<project>/.claude/worktrees/<name>`, MAIN is the default and the
  // user can flip to the worktree via the inline nudge below the CWD line.
  // Otherwise the source path is used as-is. Declared here -- before
  // `handleSpawn` -- so the useCallback dep array can reference it.
  const worktreeCtx = useMemo(
    () => (state.options?.path ? detectWorktree(state.options.path) : null),
    [state.options?.path],
  )
  const effectivePath = worktreeCtx
    ? useWorktreePath
      ? worktreeCtx.worktreePath
      : worktreeCtx.mainPath
    : (state.options?.path ?? '')

  const handleSpawn = useSpawnAction({
    state,
    phase,
    effectivePath,
    name,
    description,
    sentinelProfile,
    sentinelPool,
    headless,
    bare,
    repl,
    model,
    effort,
    agent,
    permissionMode,
    autocompactPct,
    maxBudgetUsd,
    resumeId,
    includePartialMessages,
    useWorktree,
    worktreeName,
    envText,
    backend,
    transport,
    isDaemonTransport,
    chatConnectionId,
    chatConnections,
    openCodeModel,
    openCodeToolPermission,
    hermesGatewayId,
    daemonMode,
    daemonForm,
    daemonAttach,
    progress,
    setPhase,
    setJobId,
    setWrapperId,
    setDaemonErrors,
    setConfigTab,
    conversationAtSpawnRef,
  })

  // Keyboard layer: Enter spawns (config) or views conversation (launching). Radix Dialog handles Escape.
  // Config-only quick toggles: h/p/d = Headless/PTY/Daemon, 1/2 = Basic/Advanced tab.
  // Single-letter/digit bindings are auto-skipped when a text input is focused
  // (see useKeyLayer: `if (inTextInput && !isModified && !isNonPrintable) return`).
  useKeyLayer(
    {
      Enter: () => {
        if (phase === 'config') handleSpawn()
        else if (phase === 'launching' && progress.isConnected) handleViewConversation()
      },
      h: () => {
        if (phase !== 'config' || !showProcessModel) return
        setProcessModel('claude-headless')
      },
      p: () => {
        if (phase !== 'config' || !showProcessModel) return
        setProcessModel('claude-pty')
      },
      d: () => {
        if (phase !== 'config' || !showProcessModel) return
        setProcessModel('claude-daemon')
      },
      '1': () => {
        if (phase !== 'config') return
        setConfigTab('basic')
        haptic('tick')
      },
      '2': () => {
        if (phase !== 'config') return
        setConfigTab('advanced')
        haptic('tick')
      },
      // Backend selector hotkeys (alt+1..4 = Claude/Chat/Hermes/OpenCode).
      // Modifier-prefixed so they work even when the prompt textarea is focused.
      'alt+1': () => {
        if (phase !== 'config') return
        setBackend('claude')
        haptic('tap')
      },
      'alt+2': () => {
        if (phase !== 'config') return
        if (!chatConnections.some(c => c.enabled)) return
        setBackend('chat-api')
        haptic('tap')
      },
      'alt+3': () => {
        if (phase !== 'config') return
        if (!hermesGateways.some(g => g.connected)) return
        setBackend('hermes')
        haptic('tap')
      },
      'alt+4': () => {
        if (phase !== 'config') return
        setBackend('opencode')
        haptic('tap')
      },
      // Daemon is no longer a backend hotkey (transport reframe) -- it is the
      // "Daemon" Process model for the claude backend, picked via the
      // ProcessModelSegmented control.
    },
    { id: 'spawn-dialog', enabled: state.open },
  )

  function buildSpawnDefaults() {
    return {
      defaultLaunchMode: headless ? ('headless' as const) : ('pty' as const),
      defaultEffort: effort ? (effort as 'low' | 'medium' | 'high' | 'max') : ('default' as const),
      defaultModel: model || '',
      defaultBare: bare,
      defaultRepl: repl,
      defaultPermissionMode: permissionMode
        ? (permissionMode as 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions')
        : ('default' as const),
      defaultAutocompactPct: autocompactPct ? Number(autocompactPct) : 0,
      defaultMaxBudgetUsd: maxBudgetUsd ? Number(maxBudgetUsd) : 0,
      defaultIncludePartialMessages: includePartialMessages,
      defaultEnvText: envText.trim(),
    }
  }

  function handleSaveProjectDefaults() {
    if (!state.options) return
    const defaults = buildSpawnDefaults()
    // Save against the main project path so worktree launches share the
    // project's defaults (mirrors the open-time normalization).
    const settingsPath = worktreeCtx?.mainPath ?? state.options.path
    updateProjectSettings(cwdToProjectUri(settingsPath), defaults)
    setSavedFeedback('project')
    haptic('success')
    setTimeout(() => setSavedFeedback(null), 2000)
  }

  function handleSaveGlobalDefaults() {
    const defaults = buildSpawnDefaults()
    wsSend('update_settings', { settings: defaults })
    setSavedFeedback('global')
    haptic('success')
    setTimeout(() => setSavedFeedback(null), 2000)
  }

  function handleResetDefaults() {
    setHeadless(true)
    setModel('')
    setEffort('')
    setAgent('')
    setBare(false)
    setRepl(false)
    setPermissionMode('')
    setAutocompactPct('')
    setMaxBudgetUsd('')
    setIncludePartialMessages(true)
    setEnvText('')
    haptic('tap')
  }

  function handleCopyLog() {
    const [parsedEnv] = parseEnvText(envText)
    const diag = buildSpawnDiagnostics({
      source: 'spawn-dialog',
      jobId,
      connectionId: conversationId || progress.launch.conversationId || null,
      conversationId: progress.launch.conversationId ?? null,
      elapsedSec: progress.elapsed,
      error: progress.error || progress.launch.error || null,
      config: {
        cwd: effectivePath,
        headless,
        bare,
        name: name || undefined,
        model: (model || undefined) as SpawnRequest['model'],
        effort: (effort || undefined) as SpawnRequest['effort'],
        permissionMode: (permissionMode || undefined) as SpawnRequest['permissionMode'],
        env: parsedEnv ?? undefined,
      },
      steps: progress.steps.map(s => ({
        label: s.label,
        status: s.status,
        detail: s.detail ?? null,
        ts: s.ts ?? null,
      })),
      launchEvents: progress.launch.events.map(e => ({
        step: e.step,
        status: e.status,
        detail: e.detail ?? null,
        t: e.t,
      })),
      launchState: { completed: progress.launch.completed, failed: progress.launch.failed },
    })
    progress.copyToClipboard(JSON.stringify(diag, null, 2))
  }

  const shortPath = effectivePath.replace(/^\/Users\/[^/]+/, '~')
  const displayError = progress.error || progress.launch.error

  function applyFieldsPatch(patch: Partial<LaunchFieldsValue>) {
    if ('model' in patch) setModel(patch.model ?? '')
    if ('effort' in patch) setEffort(patch.effort ?? '')
    if ('agent' in patch) setAgent(patch.agent ?? '')
    if ('permissionMode' in patch) setPermissionMode(patch.permissionMode ?? '')
    if ('autocompactPct' in patch) setAutocompactPct(patch.autocompactPct ?? '')
    if ('maxBudgetUsd' in patch) setMaxBudgetUsd(patch.maxBudgetUsd ?? '')
    if ('useWorktree' in patch) setUseWorktree(!!patch.useWorktree)
    if ('worktreeName' in patch) setWorktreeName(patch.worktreeName ?? '')
    if ('envText' in patch) setEnvText(patch.envText ?? '')
    if ('name' in patch) setName(patch.name ?? '')
    if ('description' in patch) setDescription(patch.description ?? '')
    if ('includePartialMessages' in patch) setIncludePartialMessages(patch.includePartialMessages ?? true)
    if ('headless' in patch) {
      setHeadless(!!patch.headless)
      haptic('tap')
    }
    if ('bare' in patch) setBare(!!patch.bare)
    if ('repl' in patch) setRepl(!!patch.repl)
  }

  function patchDaemonForm(patch: Partial<DaemonModeFormValue>) {
    setDaemonForm(prev => ({ ...prev, ...patch }))
    if (daemonErrors.length) setDaemonErrors([])
  }

  // Look up the target sentinel's reported profiles + defaultSelection so the
  // Sentinel-profile radio knows what to offer. Falls back to no profiles
  // (radio hides) when the sentinel is unknown / disconnected. The dialog
  // routes to `options.sentinel` (or the default sentinel if absent).
  const targetSentinelAlias = (state.options?.sentinel || 'default').toLowerCase()
  const targetSentinel = sentinelStatuses.find(s => s.alias.toLowerCase() === targetSentinelAlias)
  const targetProfiles = targetSentinel?.profiles ?? []
  const targetPools = targetSentinel?.pools ?? []
  const targetDefaultPool = targetSentinel?.defaultPool
  // Build the per-profile usage map for the radio's inline mini-bars. Map
  // keyed by NAME (radio knows nothing about the sentinelId); we filter
  // `profileUsage` to entries from THIS sentinel so cross-sentinel name
  // collisions (work@default vs work@beast) don't bleed into the picker.
  const profileUsageMap = useMemo(() => {
    const out = new Map<string, ProfileUsageSnapshot>()
    if (!targetSentinel) return out
    for (const entry of Object.values(profileUsage)) {
      if (entry.sentinelId === targetSentinel.sentinelId) out.set(entry.profile, entry)
    }
    return out
  }, [profileUsage, targetSentinel])

  const fieldsValue: LaunchFieldsValue = {
    model,
    effort,
    agent,
    permissionMode,
    autocompactPct,
    maxBudgetUsd,
    includePartialMessages,
    useWorktree,
    worktreeName,
    envText,
    name,
    description,
    headless,
    bare,
    repl,
  }

  return (
    <Dialog open={state.open} onOpenChange={(open: boolean) => !open && handleClose()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 flex flex-col gap-4 min-h-0 max-h-[calc(85vh-2rem)]">
          <div className="flex items-center justify-between shrink-0">
            <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
              {phase === 'launching' && <Zap className="size-4 text-primary" />}
              {phase === 'config'
                ? 'SPAWN SESSION'
                : progress.isConnected
                  ? 'SESSION CONNECTED'
                  : progress.hasError
                    ? 'SPAWN FAILED'
                    : 'LAUNCHING...'}
            </DialogTitle>
            {phase === 'launching' && (
              <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums">{progress.elapsed}s</span>
            )}
          </div>

          {/* CWD display + worktree nudge.
              When the trigger path is inside `.../.claude/worktrees/<name>`,
              MAIN is the default and we surface a one-click switch to the
              worktree. State is per-open (not sticky) -- see useWorktreePath. */}
          <div className="shrink-0 space-y-1">
            <div className="text-[11px] font-mono text-muted-foreground truncate">{shortPath}</div>
            {worktreeCtx && !useWorktreePath && (
              <button
                type="button"
                onClick={() => {
                  setUseWorktreePath(true)
                  haptic('tap')
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1.5 rounded',
                  'border border-amber-500/40 bg-amber-500/10',
                  'text-[10px] font-mono text-amber-200',
                  'hover:bg-amber-500/20 hover:border-amber-500/60',
                  'transition-colors text-left',
                )}
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="flex-1 min-w-0 truncate">
                  Detected worktree <span className="font-bold">{worktreeCtx.worktreeName}</span> -- click to launch
                  there instead
                </span>
                <span className="text-amber-400 shrink-0">-&gt;</span>
              </button>
            )}
            {worktreeCtx && useWorktreePath && (
              <div className="flex items-center gap-2 px-1 text-[10px] font-mono text-comment">
                <GitBranch className="size-3 text-primary" />
                <span className="flex-1 min-w-0 truncate">
                  Launching in worktree <span className="text-foreground">{worktreeCtx.worktreeName}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setUseWorktreePath(false)
                    haptic('tap')
                  }}
                  className="text-comment hover:text-foreground underline-offset-2 hover:underline"
                >
                  use main
                </button>
              </div>
            )}
          </div>

          {/* ── Config Phase ── */}
          {phase === 'config' && (
            <>
              <div className="flex items-center justify-between shrink-0 gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Profile</span>
                <ProfileDropdown
                  selectedId={profileId}
                  profiles={launchProfiles}
                  onSelectProfile={id => {
                    const profile = launchProfiles.find(p => p.id === id)
                    if (!profile) return
                    setProfileId(id)
                    applyProfileToForm(profile, {
                      setHeadless,
                      setModel,
                      setEffort,
                      setAgent,
                      setBare,
                      setRepl,
                      setPermissionMode,
                      setAutocompactPct,
                      setMaxBudgetUsd,
                      setIncludePartialMessages,
                      setBackend,
                      setEnvText,
                      setOpenCodeModel,
                      setOpenCodeToolPermission,
                      setIsDaemon,
                      setDaemonMode,
                      setDaemonForm,
                      setSentinelProfile,
                    })
                  }}
                  onPickCustom={() => setProfileId(undefined)}
                  onManage={() => openLaunchProfileManager()}
                  onCreate={async () => {
                    const draft = blankProfile()
                    draft.spawn = formSnapshotToProfileSpawn({
                      model,
                      effort,
                      agent,
                      permissionMode,
                      autocompactPct,
                      maxBudgetUsd,
                      headless,
                      bare,
                      repl,
                      includePartialMessages,
                      backend,
                      envText,
                      openCodeModel: openCodeModel || undefined,
                      toolPermission: openCodeToolPermission,
                      isDaemon: isDaemonTransport,
                      daemonForm,
                      sentinelProfile: sentinelProfile || undefined,
                    })
                    await putLaunchProfiles([...launchProfilesRef.current, draft])
                    handleClose()
                    openLaunchProfileManager(draft.id)
                  }}
                />
              </div>
              {/* Backend selector (Claude / Chat / Hermes / OpenCode). The
                  daemon is not a backend -- it is selected via the Process
                  model control below. */}
              <div className="shrink-0">
                <BackendSelect
                  value={backend}
                  onChange={v => {
                    if (profileId && v !== backend) setProfileId(undefined)
                    setBackend(v)
                  }}
                  chatAvailable={chatConnections.some(c => c.enabled)}
                  hermesAvailable={hermesGateways.some(g => g.connected)}
                />
              </div>

              {/* Process model (claude family only): Interactive PTY / Headless
                  / Daemon -- maps to transport. */}
              {showProcessModel && (
                <div className="shrink-0 px-1.5">
                  <ProcessModelSegmented value={transport} onChange={setProcessModel} shortcutHints />
                </div>
              )}

              {/* Sentinel-profile selector -- only rendered when the target
                  sentinel reports >1 profile (single-profile sentinels have
                  nothing to choose between). The radio holds INTENT; the
                  sentinel resolves it at spawn time. Profile-Env Boundary:
                  this only consumes NAMES + display from `targetProfiles`. */}
              {targetProfiles.length > 1 && (
                <div className="shrink-0 px-1.5">
                  <SentinelProfileRadio
                    profiles={targetProfiles}
                    pools={targetPools}
                    defaultPool={targetDefaultPool}
                    value={sentinelProfile}
                    onChange={v => {
                      setSentinelProfile(v)
                      haptic('tick')
                    }}
                    poolValue={sentinelPool}
                    onPoolChange={v => {
                      setSentinelPool(v)
                      haptic('tick')
                    }}
                    profileUsage={profileUsageMap}
                  />
                </div>
              )}

              {/* -- Daemon config (New / Resume / Attach) -- gated on the
                  daemon transport (transport reframe Phase 5). -- */}
              {isDaemonTransport ? (
                <div className="flex flex-col gap-3 flex-1 min-h-0">
                  <div className="shrink-0 px-1.5">
                    <DaemonModeSegmented
                      mode={daemonMode}
                      onChange={m => {
                        setDaemonMode(m)
                        setDaemonErrors([])
                      }}
                    />
                  </div>
                  {daemonMode === 'attach' ? (
                    /* ATTACH carries no config -- the worker is already
                       configured. No Basic/Advanced tabs, just the roster
                       picker + the conversation label fields. */
                    <div className="overflow-y-auto flex-1 min-h-0 space-y-3 px-1.5 py-1">
                      <DaemonRosterBrowser
                        selectedShort={daemonAttach?.short}
                        onSelect={entry => {
                          setDaemonAttach(entry)
                          setDaemonErrors([])
                        }}
                      />
                      <LaunchConfigFields
                        value={fieldsValue}
                        onChange={applyFieldsPatch}
                        show={{ name: true, description: true }}
                      />
                    </div>
                  ) : (
                    /* NEW/RESUME use the same Basic/Advanced tabs as the
                       Interactive/Headless dialog (1/2 hotkeys apply). */
                    <>
                      <div className="shrink-0 px-1.5">
                        <ConfigTabBar value={configTab} onChange={setConfigTab} />
                      </div>
                      <div className="overflow-y-auto flex-1 min-h-0 space-y-3 px-1.5 py-1">
                        <DaemonModePanel
                          mode={daemonMode}
                          tab={configTab}
                          value={daemonForm}
                          onChange={patchDaemonForm}
                        />
                        {configTab === 'basic' && (
                          <LaunchConfigFields
                            value={fieldsValue}
                            onChange={applyFieldsPatch}
                            show={{ name: true, description: true }}
                          />
                        )}
                      </div>
                    </>
                  )}
                  {daemonErrors.length > 0 && (
                    <div className="shrink-0 mx-1.5 text-[10px] font-mono text-red-400 space-y-0.5 border border-red-500/30 bg-red-950/20 rounded px-2 py-1.5">
                      {daemonErrors.map(e => (
                        <div key={e}>{e}</div>
                      ))}
                    </div>
                  )}
                </div>
              ) : /* -- Hermes config -- */
              backend === 'hermes' ? (
                <div className="space-y-3 px-1.5 py-1">
                  <HermesGatewayPicker
                    gateways={hermesGateways}
                    value={hermesGatewayId}
                    onChange={setHermesGatewayId}
                  />
                  <LaunchConfigFields
                    value={fieldsValue}
                    onChange={applyFieldsPatch}
                    show={{ name: true, description: true }}
                  />
                </div>
              ) : /* -- OpenCode config -- */
              backend === 'opencode' ? (
                <div className="space-y-3 px-1.5 py-1">
                  <div className="space-y-2">
                    <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">
                      Model (optional)
                    </div>
                    <select
                      value={
                        openCodeModelCustom
                          ? OPENCODE_CUSTOM_SENTINEL
                          : openCodeModel === ''
                            ? OPENCODE_DEFAULT_SENTINEL
                            : OPENCODE_CURATED_VALUES.has(openCodeModel)
                              ? openCodeModel
                              : OPENCODE_CUSTOM_SENTINEL
                      }
                      onChange={e => {
                        const v = e.target.value
                        if (v === OPENCODE_DEFAULT_SENTINEL) {
                          setOpenCodeModel('')
                          setOpenCodeModelCustom(false)
                        } else if (v === OPENCODE_CUSTOM_SENTINEL) {
                          // Switch to free-text -- preserve any non-curated value already typed.
                          setOpenCodeModelCustom(true)
                        } else {
                          setOpenCodeModel(v)
                          setOpenCodeModelCustom(false)
                        }
                      }}
                      className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                    >
                      <option value={OPENCODE_DEFAULT_SENTINEL}>(OpenCode default)</option>
                      <optgroup label="OpenCode Go">
                        {OPENCODE_GO_MODELS.map(m => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="OpenCode Zen">
                        {OPENCODE_ZEN_MODELS.map(m => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </optgroup>
                      <option value={OPENCODE_CUSTOM_SENTINEL}>Custom…</option>
                    </select>
                    {openCodeModelCustom ? (
                      <input
                        type="text"
                        value={openCodeModel}
                        onChange={e => setOpenCodeModel(e.target.value)}
                        placeholder="openrouter/anthropic/claude-haiku-4.5"
                        spellCheck={false}
                        autoCapitalize="off"
                        className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                      />
                    ) : null}
                    <div className="text-[10px] font-mono text-muted-foreground/70 pl-0.5 leading-relaxed">
                      <div>
                        OpenCode Go / Zen require <span className="text-foreground/80">opencode auth login</span> on the
                        sentinel host (~/.local/share/opencode/auth.json).
                      </div>
                      <div>
                        OpenRouter / Anthropic / OpenAI direct-providers use{' '}
                        <span className="text-foreground/80">OPENROUTER_API_KEY</span> /{' '}
                        <span className="text-foreground/80">ANTHROPIC_API_KEY</span> /{' '}
                        <span className="text-foreground/80">OPENAI_API_KEY</span> in the sentinel env.
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">
                      Tools
                    </div>
                    <select
                      value={openCodeToolPermission}
                      onChange={e => setOpenCodeToolPermission(e.target.value as OpenCodeToolPermission)}
                      className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                    >
                      {OPENCODE_TOOL_PERMISSION_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <div className="text-[10px] font-mono text-muted-foreground/70 pl-0.5">
                      {OPENCODE_TOOL_PERMISSION_OPTIONS.find(o => o.value === openCodeToolPermission)?.info}
                    </div>
                  </div>
                  <LaunchConfigFields
                    value={fieldsValue}
                    onChange={applyFieldsPatch}
                    show={{ name: true, description: true }}
                  />
                </div>
              ) : /* -- Chat API config -- */
              backend === 'chat-api' ? (
                <div className="space-y-3 px-1.5 py-1">
                  <div className="space-y-2">
                    <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">
                      Connection
                    </div>
                    <select
                      value={chatConnectionId}
                      onChange={e => setChatConnectionId(e.target.value)}
                      className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                    >
                      <option value="">Select connection…</option>
                      {(() => {
                        const opts: ReactNode[] = []
                        for (const a of chatConnections) {
                          if (!a.enabled) continue
                          opts.push(
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>,
                          )
                        }
                        return opts
                      })()}
                    </select>
                  </div>
                  <LaunchConfigFields
                    value={fieldsValue}
                    onChange={applyFieldsPatch}
                    show={{ name: true, description: true }}
                  />
                </div>
              ) : (
                <>
                  <ConfigTabBar value={configTab} onChange={setConfigTab} />

                  {/* Scrollable content area.
                  Inner padding gives focus rings (ring-[3px]) room; without
                  this, overflow-y:auto implicitly clips overflow-x and the
                  blue focus ring on inputs/selects gets sliced off. */}
                  <div className="overflow-y-auto flex-1 min-h-0 space-y-4 px-1.5 py-1">
                    {configTab === 'basic' && (
                      <div className="space-y-3">
                        {/* Headless/PTY is now the Process model control above; the
                            basic tab no longer renders a separate Mode toggle. */}
                        <LaunchConfigFields
                          value={fieldsValue}
                          onChange={applyFieldsPatch}
                          show={{ name: true, description: true, model: true, effort: true }}
                        />
                      </div>
                    )}

                    {configTab === 'advanced' && (
                      <div className="space-y-3">
                        <LaunchConfigFields
                          value={fieldsValue}
                          onChange={applyFieldsPatch}
                          show={{
                            agent: true,
                            permissionMode: true,
                            autocompactPct: true,
                            maxBudgetUsd: headless,
                            includePartialMessages: headless,
                            worktree: true,
                            repl: true,
                            bare: true,
                          }}
                        />

                        {/* Resume existing CC session */}
                        <ResumeSessionField
                          resumeId={resumeId}
                          onResumeIdChange={setResumeId}
                          cwd={effectivePath}
                          sentinel={state.options?.sentinel}
                        />

                        {/* Env vars (LaunchConfigFields renders textarea + inline errors) */}
                        <LaunchConfigFields value={fieldsValue} onChange={applyFieldsPatch} show={{ env: true }} />
                        <div className="text-[9px] text-comment">
                          KEY=value per line, set before executing claude. # comments ok.
                        </div>

                        {/* Save / Reset defaults */}
                        <div className="flex items-center gap-3 pt-1">
                          <button
                            type="button"
                            onClick={handleSaveProjectDefaults}
                            className="text-[10px] font-mono text-primary/70 hover:text-primary transition-colors"
                          >
                            {savedFeedback === 'project' ? 'Saved!' : 'Save for project'}
                          </button>
                          <span className="text-border">|</span>
                          <button
                            type="button"
                            onClick={handleSaveGlobalDefaults}
                            className="text-[10px] font-mono text-comment hover:text-muted-foreground transition-colors"
                          >
                            {savedFeedback === 'global' ? 'Saved!' : 'Save globally'}
                          </button>
                          <span className="text-border">|</span>
                          <button
                            type="button"
                            onClick={handleResetDefaults}
                            className="text-[10px] font-mono text-comment hover:text-red-400 transition-colors"
                          >
                            Reset
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          <LaunchDialogBottom
            phase={phase}
            steps={progress.steps}
            displayError={displayError}
            copied={progress.copied}
            onCopyLog={handleCopyLog}
            onClose={handleClose}
            onAction={handleSpawn}
            actionLabel="Spawn"
            actionColorClass="bg-primary text-background hover:bg-primary/90"
            isConnected={progress.isConnected}
            isComplete={progress.isComplete}
            hasError={progress.hasError}
            viewCountdown={progress.viewCountdown}
            onViewConversation={() => {
              progress.setViewCountdown(null)
              handleViewConversation()
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Resume Session Field ──────────────────────────────────────────────

function ResumeSessionField({
  resumeId,
  onResumeIdChange,
  cwd,
  sentinel,
}: {
  resumeId: string
  onResumeIdChange: (id: string) => void
  cwd: string
  sentinel?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [sessions, setSessions] = useState<CcSessionEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleToggle() {
    const next = !expanded
    setExpanded(next)
    if (next && sessions.length === 0 && !loading) fetchSessions()
  }

  function fetchSessions() {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ cwd })
    if (sentinel) params.set('sentinel', sentinel)
    fetch(`/api/cc-sessions?${params}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) setError(data.error)
        else setSessions(data.ccSessions || [])
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false))
  }

  function formatAge(mtime: number): string {
    const diff = Date.now() - mtime
    const mins = Math.floor(diff / 60_000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown className={cn('w-3 h-3 transition-transform', !expanded && '-rotate-90')} />
        Resume CC session
        {resumeId.trim() && <span className="text-amber-400/80 ml-1">(set)</span>}
      </button>

      {expanded && (
        <div className="space-y-1.5 pl-4">
          <input
            type="text"
            value={resumeId}
            onChange={e => onResumeIdChange(e.target.value)}
            placeholder="CC session ID"
            className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          {resumeId.trim() && (
            <div className="text-[9px] text-amber-400/80">
              Will pass --resume to CC. Fails if session ID is invalid.
            </div>
          )}

          {loading && <div className="text-[9px] font-mono text-comment">Loading sessions…</div>}
          {error && <div className="text-[9px] font-mono text-red-400">{error}</div>}

          {sessions.length > 0 && (
            <div className="max-h-[160px] overflow-y-auto border border-border rounded">
              {sessions.map(s => (
                <button
                  key={s.ccSessionId}
                  type="button"
                  onClick={() => {
                    onResumeIdChange(s.ccSessionId)
                    haptic('tap')
                  }}
                  className={cn(
                    'w-full text-left px-2 py-1.5 text-[10px] font-mono border-b border-border last:border-b-0 transition-colors',
                    resumeId === s.ccSessionId
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-surface-inset hover:text-foreground',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{s.title || s.ccSessionId.slice(0, 8)}</span>
                    <span className="text-[9px] text-comment shrink-0">
                      {formatAge(s.mtime)} / {formatSize(s.sizeBytes)}
                    </span>
                  </div>
                  <div className="text-[9px] text-comment truncate">{s.ccSessionId}</div>
                </button>
              ))}
            </div>
          )}

          {!loading && !error && sessions.length === 0 && expanded && (
            <div className="text-[9px] font-mono text-comment">No CC sessions found for this path.</div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Hermes Gateway Picker ────────────────────────────────────────────
// Picker only renders when there's something meaningful to choose. Single
// connected gateway = nothing to choose, hide the picker entirely (auto-select
// already happened during fetch). Zero connected = show a hint that deep-links
// to the manage dialog. >1 connected = show the actual select.

function HermesGatewayPicker({
  gateways,
  value,
  onChange,
}: {
  gateways: HermesGateway[]
  value: string
  onChange: (id: string) => void
}) {
  const connected = gateways.filter(g => g.connected)

  if (connected.length === 0) {
    return (
      <div className="text-[10px] font-mono text-amber-400/80 bg-amber-950/20 border border-amber-400/30 rounded px-2 py-1.5 leading-snug">
        No Hermes gateway connected.{' '}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('open-gateway-manager'))}
          className="underline hover:text-amber-300"
        >
          Manage Hermes connections…
        </button>
      </div>
    )
  }

  if (connected.length === 1) return null

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">Gateway</div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
      >
        <option value="">Select gateway…</option>
        {connected.map(g => (
          <option key={g.gatewayId} value={g.gatewayId}>
            {g.alias}
            {g.label ? ` -- ${g.label}` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

// ─── Basic / Advanced Tab Bar ─────────────────────────────────────────
// Shared by the Claude PTY/Headless config and the daemon NEW/RESUME config
// so both honor the 1/2 hotkeys identically. Single source of truth for the
// tab chrome -- don't inline a second copy.

function ConfigTabBar({
  value,
  onChange,
}: {
  value: 'basic' | 'advanced'
  onChange: (tab: 'basic' | 'advanced') => void
}) {
  const tabs: Array<{ key: 'basic' | 'advanced'; label: string; hint: string }> = [
    { key: 'basic', label: 'Basic', hint: '1' },
    { key: 'advanced', label: 'Advanced', hint: '2' },
  ]
  return (
    <div className="flex gap-1.5 shrink-0">
      {tabs.map(t => (
        <button
          key={t.key}
          type="button"
          onClick={() => {
            onChange(t.key)
            haptic('tick')
          }}
          className={cn(
            'px-3 py-1 text-[11px] font-mono rounded transition-colors inline-flex items-center gap-1.5',
            value === t.key
              ? 'bg-primary/15 text-primary border border-primary/30'
              : 'text-comment hover:text-muted-foreground',
          )}
        >
          {t.label}
          <Kbd className="text-[10px]">{t.hint}</Kbd>
        </button>
      ))}
    </div>
  )
}

// ─── Daemon Mode Segmented Control ────────────────────────────────────
// New / Resume / Attach selector for the daemon backend. New + Resume run
// `claude --bg`; Attach takes over an already-running daemon worker.

const DAEMON_MODE_OPTIONS: Array<{ value: DaemonMode; label: string; hint: string }> = [
  { value: 'new', label: 'New', hint: 'claude --bg a fresh worker' },
  { value: 'resume', label: 'Resume', hint: 'claude --bg --resume a session' },
  { value: 'attach', label: 'Attach', hint: 'take over a running worker' },
]

function DaemonModeSegmented({ mode, onChange }: { mode: DaemonMode; onChange: (m: DaemonMode) => void }) {
  return (
    <div className="space-y-1">
      <div className="flex gap-1.5">
        {DAEMON_MODE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            title={opt.hint}
            onClick={() => {
              onChange(opt.value)
              haptic('tick')
            }}
            className={cn(
              'flex-1 px-2 py-1 text-[11px] font-mono rounded transition-colors border',
              mode === opt.value
                ? 'bg-primary/15 text-primary border-primary/30'
                : 'text-comment border-transparent hover:text-muted-foreground',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="text-[9px] text-comment pl-0.5">{DAEMON_MODE_OPTIONS.find(o => o.value === mode)?.hint}</div>
    </div>
  )
}
