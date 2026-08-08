import { projectIdentityKey } from '@shared/project-uri'
/**
 * Revive Dialog - Pre-revive configuration + launch monitor.
 *
 * Mirrors SpawnDialog (two-phase config -> launching) but for reviving an
 * ended conversations. Only the minimal overrides are exposed (mode + model +
 * effort) -- everything else (permissionMode, bare, repl, worktree, env,
 * autocompact, budget) is inherited from the conversation's stored launch config
 * and project/global defaults. See `reviveConversation` handler in
 * `src/broker/handlers/control-panel-actions.ts` for the resolution chain.
 */

import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { TogglePill } from '@/components/ui/toggle-pill'
import { reviveConversation, useConversationsStore } from '@/hooks/use-conversations'
import { focusLaunchTargetAndClose, useLaunchProgress } from '@/hooks/use-launch-progress'
import { useKeyLayer } from '@/lib/key-layers'
import { shortenHomePath } from '@/lib/short-path'
import { projectPath } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { LaunchConfigFields, type LaunchFieldsValue } from './launch-config-fields'
import { LaunchDialogBottom } from './launch-monitor'
import { type ReviveDialogOptions, reviveDialogBus } from './revive-dialog-trigger'
import { buildProfileUsageMap, resolveReviveDefaultProfile } from './spawn-dialog/profile-usage'
import { SentinelProfileRadio } from './spawn-dialog/sentinel-profile-radio'

interface ReviveDialogState {
  open: boolean
  options: ReviveDialogOptions | null
}

/** 85% auto-unpin threshold. Over this on the original profile's worst usage
 *  window, the revive dialog pre-selects a fresher profile instead of pinning. */
const UNPIN_USAGE_PCT = 85

export function ReviveDialog() {
  const [state, setState] = useState<ReviveDialogState>({ open: false, options: null })
  const [headless, setHeadless] = useState(true)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [sentinelProfile, setSentinelProfile] = useState('')
  const [phase, setPhase] = useState<'config' | 'launching'>('config')
  const [jobId, setJobId] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const conversationAtReviveRef = useRef<string | null>(null)

  const conversationsById = useConversationsStore(s => s.conversationsById)
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const globalSettings = useConversationsStore(s => s.globalSettings)
  const sentinelStatuses = useConversationsStore(s => s.sentinels)
  const profileUsage = useConversationsStore(s => s.profileUsage)

  const conversation = state.options ? conversationsById[state.options.conversationId] : undefined

  // The profile this conversation was originally resolved onto. `default` is
  // the implicit profile when unset. Revive PINS here unless the user picks
  // another (or the 85% auto-unpin pre-selects a fresher one).
  const originalProfile = conversation?.resolvedProfile || 'default'

  // Look up the conversation's host sentinel so the picker can offer that
  // sentinel's reported profiles + their live usage. Profile-Env Boundary:
  // NAMES + display + usage only -- never configDir / env.
  const targetSentinel = useMemo(() => {
    const alias = (conversation?.hostSentinelAlias || 'default').toLowerCase()
    return sentinelStatuses.find(s => s.alias.toLowerCase() === alias)
  }, [conversation?.hostSentinelAlias, sentinelStatuses])
  const targetProfiles = targetSentinel?.profiles ?? []
  const profileUsageMap = useMemo(
    () => buildProfileUsageMap(targetSentinel?.sentinelId, profileUsage),
    [profileUsage, targetSentinel],
  )

  // Mismatch = user is reviving onto a DIFFERENT profile than the original.
  // CC's --resume reads the transcript from the original profile's config dir,
  // so a mismatch means CC starts fresh -- warn (Jonas: warn-on-mismatch).
  const profileMismatch = !!sentinelProfile && sentinelProfile !== originalProfile

  const progress = useLaunchProgress({
    jobId,
    conversationId,
    timeoutMs: 30_000,
    autoConnectedStep: true,
    enabled: phase === 'launching',
    onTimeout: () => {
      progress.setSteps(prev =>
        prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: 'timed out' } : s)),
      )
    },
  })

  const progressReset = progress.reset
  useEffect(() => {
    reviveDialogBus.setHandler((options: ReviveDialogOptions) => {
      const sess = useConversationsStore.getState().conversationsById[options.conversationId]
      const ps = sess ? projectSettings[projectIdentityKey(sess.project)] : undefined
      const gs = globalSettings as Record<string, unknown>
      const lc = sess?.launchConfig

      // Resolution chain matches the server handler: launch config > project > global.
      const lcMode = lc ? (lc.headless ? 'headless' : 'pty') : undefined
      const defaultMode = lcMode || ps?.defaultLaunchMode || (gs.defaultLaunchMode as string) || 'headless'
      setHeadless(defaultMode !== 'pty')

      const defaultModel = lc?.model || ps?.defaultModel || (gs.defaultModel as string) || ''
      setModel(defaultModel)

      const defaultEffortRaw = lc?.effort || ps?.defaultEffort || (gs.defaultEffort as string) || ''
      setEffort(defaultEffortRaw === 'default' ? '' : defaultEffortRaw)

      // Default profile selection: PIN to the conversation's original profile,
      // UNLESS that profile is near its rate-limit cap (>85% on its worst
      // window) -- then auto-unpin to the freshest alternative so a desperate
      // revive lands on a usable account. Read sentinel + usage from the live
      // store (getState avoids stale closures). Profile-Env Boundary: the
      // helpers only touch NAMES + usage snapshots.
      const store = useConversationsStore.getState()
      const orig = sess?.resolvedProfile || 'default'
      const alias = (sess?.hostSentinelAlias || 'default').toLowerCase()
      const snt = store.sentinels.find(s => s.alias.toLowerCase() === alias)
      const usageByName = buildProfileUsageMap(snt?.sentinelId, store.profileUsage)
      setSentinelProfile(resolveReviveDefaultProfile(orig, snt?.profiles ?? [], usageByName, UNPIN_USAGE_PCT))

      setPhase('config')
      setJobId(null)
      setConversationId(null)
      progressReset()
      closedOnDoneRef.current = false
      setState({ open: true, options })
    })
    return () => {
      reviveDialogBus.setHandler(null)
    }
  }, [projectSettings, globalSettings, progressReset])

  // Guards the close-on-done effect so it fires exactly once per launch.
  const closedOnDoneRef = useRef(false)

  const handleClose = useCallback(() => {
    focusLaunchTargetAndClose({
      launchConversationId: progress.launch.conversationId,
      spawnedConversation: progress.spawnedConversation,
      conversationAtLaunch: conversationAtReviveRef.current,
      reason: 'revive-dialog-close',
      close: () => {
        setState({ open: false, options: null })
        setJobId(null)
      },
    })
  }, [progress.launch.conversationId, progress.spawnedConversation])

  // Done is done: close the instant the conversation connects (which focuses it
  // via handleClose). No countdown, no lingering timer. One-shot per launch.
  useEffect(() => {
    if (!progress.isConnected || progress.hasError || closedOnDoneRef.current) return
    closedOnDoneRef.current = true
    handleClose()
  }, [progress.isConnected, progress.hasError, handleClose])

  // Legacy agent events -- keep the listeners from the old ReviveMonitor for
  // backwards compat with older agents that don't emit launch channel events.
  useEffect(() => {
    function handleAck(e: Event) {
      const detail = (e as CustomEvent).detail
      if (!detail) return
      if (detail.ok === false) {
        progress.setError(detail.error || 'Revive rejected')
        progress.setSteps(prev =>
          prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: detail.error } : s)),
        )
        return
      }
      const wid = detail.conversationId as string
      setConversationId(wid)
      progress.setSteps(prev => [
        ...prev.map(s =>
          s.status === 'active'
            ? {
                ...s,
                status: 'done' as const,
                detail: detail.name ? `${detail.name}` : `agent-host=${wid?.slice(0, 8)}`,
              }
            : s,
        ),
        { label: 'Sentinel processing...', status: 'active', ts: Date.now() },
      ])
    }
    window.addEventListener('revive-conversation-result', handleAck)
    return () => window.removeEventListener('revive-conversation-result', handleAck)
  }, [progress.setError, progress.setSteps])

  const handleViewConversation = useCallback(() => {
    const sid = progress.launch.conversationId || progress.spawnedConversation?.id
    if (sid) useConversationsStore.getState().selectConversation(sid, 'revive-dialog-view-conversation')
    setState({ open: false, options: null })
    setJobId(null)
  }, [progress.launch.conversationId, progress.spawnedConversation])

  const handleRevive = useCallback(() => {
    if (!state.options || phase !== 'config' || !conversation) return

    setPhase('launching')
    conversationAtReviveRef.current = useConversationsStore.getState().selectedConversationId
    haptic('tap')

    const newJobId = crypto.randomUUID()
    setJobId(newJobId)
    progress.start([{ label: 'Sending revive request...', status: 'active', ts: Date.now() }])

    const sent = reviveConversation(state.options.conversationId, {
      headless,
      jobId: newJobId,
      model: model || undefined,
      effort: effort || undefined,
      // Only send a profile override when it differs from the original --
      // otherwise omit so the broker pins to conversation.resolvedProfile.
      profile: profileMismatch ? sentinelProfile : undefined,
    })

    if (!sent) {
      progress.setError('WebSocket not connected')
      progress.setSteps(prev =>
        prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: 'WS disconnected' } : s)),
      )
      haptic('error')
    }
  }, [state.options, phase, conversation, headless, model, effort, sentinelProfile, profileMismatch, progress])

  // Keyboard layer: Enter revives (config) or views conversation (launching).
  // h/p = Headless/PTY (config only).
  useKeyLayer(
    {
      Enter: () => {
        if (phase === 'config') handleRevive()
        else if (phase === 'launching' && progress.isConnected) handleViewConversation()
      },
      h: () => {
        if (phase !== 'config') return
        setHeadless(true)
        haptic('tap')
      },
      p: () => {
        if (phase !== 'config') return
        setHeadless(false)
        haptic('tap')
      },
    },
    { id: 'revive-dialog', enabled: state.open },
  )

  function applyFieldsPatch(patch: Partial<LaunchFieldsValue>) {
    if ('model' in patch) setModel(patch.model ?? '')
    if ('effort' in patch) setEffort(patch.effort ?? '')
  }

  function handleCopyLog() {
    const log = [
      '=== rclaude revive log ===',
      `Time: ${new Date().toISOString()}`,
      `Conversation: ${state.options?.conversationId ?? 'n/a'}${conversation?.title ? ` (${conversation.title})` : ''}`,
      `Project: ${conversation?.project ?? 'n/a'}`,
      `Wrapper: ${conversationId || 'n/a'}`,
      `Job: ${jobId || 'n/a'}`,
      `Headless: ${headless}`,
      `Model: ${model || '(inherited)'}`,
      `Effort: ${effort || '(inherited)'}`,
      `Profile: ${sentinelProfile || originalProfile}${profileMismatch ? ` (override, original=${originalProfile})` : ' (pinned)'}`,
      '',
      'Steps:',
      ...progress.steps.map(s => {
        const icon =
          s.status === 'done' ? '[OK]' : s.status === 'error' ? '[FAIL]' : s.status === 'active' ? '[...]' : '[ ]'
        return `  ${icon} ${s.label}${s.detail ? ` -- ${s.detail}` : ''}`
      }),
      '',
      `Error: ${progress.error || progress.launch.error || 'none'}`,
      `Elapsed: ${progress.elapsed}s`,
    ].join('\n')
    progress.copyToClipboard(log)
  }

  const shortPath = shortenHomePath(conversation ? projectPath(conversation.project) : '')
  const displayError = progress.error || progress.launch.error
  const titleLabel = conversation?.title || conversation?.agentName || shortPath

  const fieldsValue: LaunchFieldsValue = { model, effort }

  return (
    <Dialog open={state.open} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 flex flex-col gap-4 min-h-0 max-h-[calc(85vh-2rem)]">
          <div className="flex items-center justify-between shrink-0">
            <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
              {phase === 'launching' && <RefreshCw className="size-4 text-emerald-400" />}
              {phase === 'config'
                ? 'REVIVE SESSION'
                : progress.isConnected
                  ? 'SESSION CONNECTED'
                  : progress.hasError
                    ? 'REVIVE FAILED'
                    : 'REVIVING...'}
            </DialogTitle>
            {phase === 'launching' && (
              <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums">{progress.elapsed}s</span>
            )}
          </div>

          {/* Conversation display */}
          <div className="shrink-0 space-y-0.5">
            {titleLabel && <div className="text-[11px] font-mono text-foreground truncate">{titleLabel}</div>}
            <div className="text-[10px] font-mono text-muted-foreground/60 truncate">{shortPath}</div>
          </div>

          {/* Config Phase */}
          {phase === 'config' && (
            <div className="overflow-y-auto flex-1 min-h-0 space-y-4 px-1.5 py-1">
              {/* Mode toggle */}
              <div className="space-y-2">
                <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">Mode</div>
                <div className="flex gap-2">
                  <TogglePill
                    active={headless}
                    onClick={() => {
                      setHeadless(true)
                      haptic('tap')
                    }}
                    label="Headless"
                    shortcut="H"
                  />
                  <TogglePill
                    active={!headless}
                    onClick={() => {
                      setHeadless(false)
                      haptic('tap')
                    }}
                    label="PTY"
                    shortcut="P"
                  />
                </div>
              </div>

              <LaunchConfigFields
                value={fieldsValue}
                onChange={applyFieldsPatch}
                show={{ model: true, effort: true }}
              />

              {/* Sentinel-profile picker -- mirrors the launch dialog. Renders
                  only when the host sentinel reports >1 profile. Default pins
                  to the conversation's original profile; the 85% auto-unpin may
                  pre-select a fresher one. The Default ("sentinel picks") + pool
                  pills are hidden: revive pins to a concrete literal profile and
                  never re-rolls (transcript lives under the resolved configDir). */}
              {targetProfiles.length > 1 && (
                <div className="space-y-2">
                  <SentinelProfileRadio
                    profiles={targetProfiles}
                    pools={[]}
                    value={sentinelProfile}
                    onChange={v => {
                      setSentinelProfile(v)
                      haptic('tick')
                    }}
                    poolValue=""
                    onPoolChange={() => {}}
                    profileUsage={profileUsageMap}
                    hideDefault
                  />
                  {profileMismatch && (
                    <div className="text-[9px] text-amber-400/90 leading-snug border border-amber-400/30 bg-amber-400/5 rounded px-2 py-1.5">
                      Reviving on <span className="font-bold">{sentinelProfile}</span> instead of the original{' '}
                      <span className="font-bold">{originalProfile}</span>. Claude Code resumes its transcript from the
                      original profile's config dir -- on a different profile it starts fresh (no in-model context). The
                      panel transcript here is unaffected.
                    </div>
                  )}
                </div>
              )}

              <div className="text-[9px] text-comment leading-snug">
                Other settings (permission mode, env, budget, worktree, etc.) are restored from the original launch
                config. Spawn a new conversation to change them.
              </div>
            </div>
          )}

          <LaunchDialogBottom
            phase={phase}
            steps={progress.steps}
            displayError={displayError}
            copied={progress.copied}
            onCopyLog={handleCopyLog}
            onClose={handleClose}
            onAction={handleRevive}
            actionLabel="Revive"
            actionColorClass="bg-emerald-500 text-background hover:bg-emerald-500/90"
            isConnected={progress.isConnected}
            isComplete={progress.isComplete}
            hasError={progress.hasError}
            onViewConversation={handleViewConversation}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
