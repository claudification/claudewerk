/**
 * The launch dialog -- config form, then a live launch monitor.
 *
 * Split out of project-board.tsx (1766 LOC) on 2026-08-14. Mounted from the
 * board and from TaskEditorOverlay; both hand it the card the editor was on.
 */

import { openEpicRoster, wantsEpicRoster } from '@shared/epic-roster'
import { buildSpawnDiagnostics } from '@shared/spawn-diagnostics'
import { deriveConversationName } from '@shared/spawn-naming'
import { composeSpawnPrompt } from '@shared/spawn-prompt'
import type { SpawnRequest } from '@shared/spawn-schema'
import { type TaskMode, taskMode } from '@shared/task-modes'
import { Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useConversationsStore } from '@/hooks/use-conversations'
import { focusLaunchTargetAndClose, useLaunchProgress } from '@/hooks/use-launch-progress'
import { type ProjectTask, useProjectTasksList } from '@/hooks/use-project'
import { sendSpawnRequest } from '@/hooks/use-spawn'
import { applySubagentCapEnv } from '@/lib/env-parse'
import { useKeyLayer } from '@/lib/key-layers'
import { loadRunTaskDefaults, saveRunTaskDefaults } from '@/lib/run-task-defaults'
import { projectPath } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { LaunchConfigFields, type LaunchFieldsValue } from '../launch-config-fields'
import { LaunchErrorBanner, LaunchFooterActions, LaunchStepList } from '../launch-monitor'
import { modeDefaults, persistsDefaults, RunModeHint, RunModeTabs } from './run-task-mode'
import { useLaunchSteps } from './use-launch-steps'

// PRE-EXISTING complexity, not new: unchanged from project-board.tsx, where it
// was already cognitive 38 across 13 useState + 4 useEffect. The gate reads the
// move as "introduced". Collapsing the config state into a reducer is real work
// and is NOT part of the epics change.
// fallow-ignore-next-line complexity
export function RunTaskDialog({
  task,
  conversationId,
  onClose,
}: {
  task: ProjectTask
  conversationId: string
  onClose: () => void
}) {
  const spawnPath = useConversationsStore(state => {
    const s = state.conversationsById[conversationId]
    return s ? projectPath(s.project) : ''
  })
  const projectUri = useConversationsStore(state => state.conversationsById[conversationId]?.project ?? null)
  const boardCards = useProjectTasksList(projectUri)
  const savedDefaults = useMemo(() => loadRunTaskDefaults(), [])
  // THE CARD'S `model:` HINT SEEDS THE FIELD, and stops there. It outranks the
  // remembered default because it is a judgement about THIS card rather than a
  // memory of the last launch -- but it is a seed, not a lock: the dropdown is
  // right there and the human at this dialog is the one authority the hint does
  // not get to overrule. Nothing clamps it here either, because no order is in
  // play: LAUNCH spawns one conversation a human drives, at whatever tier that
  // human picks.
  const [model, setModel] = useState(task.model ?? savedDefaults.model)
  const [effort, setEffort] = useState<string>(savedDefaults.effort)
  const [useWorktree, setUseWorktree] = useState(savedDefaults.useWorktree)
  const [branchName, setBranchName] = useState(task.slug)
  const [autoCommit, setAutoCommit] = useState(savedDefaults.autoCommit)
  const [leaveRunning, setLeaveRunning] = useState(savedDefaults.leaveRunning)
  const [maxBudgetUsd, setMaxBudgetUsd] = useState(savedDefaults.maxBudgetUsd)
  const [maxConcurrentSubagents, setMaxConcurrentSubagents] = useState('')
  const [maxSubagentSpawnDepth, setMaxSubagentSpawnDepth] = useState('')
  const [includePartialMessages, setIncludePartialMessages] = useState(savedDefaults.includePartialMessages)
  const [timeout, setTimeout_] = useState(savedDefaults.timeout)
  const [mode, setMode] = useState<TaskMode>('work')
  const modeSpec = taskMode(mode)

  /**
   * The open-epic roster, and ONLY when this run can act on it: a refine of a
   * card that has no `epic:` yet. A work run does not parent cards, and a card
   * that already has a parent is not re-parented by a refiner -- in both cases
   * the block is prompt weight that changes nothing.
   */
  const epicRoster = useMemo(
    () => (wantsEpicRoster(mode === 'refine', [task]) ? openEpicRoster(boardCards) : ''),
    [mode, task, boardCards],
  )

  /** Switching mode re-picks the lifecycle switches it implies. See run-task-mode. */
  function switchMode(next: TaskMode) {
    setMode(next)
    const d = modeDefaults(next, { useWorktree: savedDefaults.useWorktree, autoCommit: savedDefaults.autoCommit })
    setUseWorktree(d.useWorktree)
    setAutoCommit(d.autoCommit)
  }

  // Launch state
  const [phase, setPhase] = useState<'config' | 'launching'>('config')
  const spawnedConversationIdRef = useRef<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const conversationAtLaunchRef = useRef<string | null>(null)

  // Shared launch progress hook
  const progress = useLaunchProgress({
    jobId,
    conversationId,
    timeoutMs: 30_000,
    enabled: phase === 'launching',
  })

  useKeyLayer({
    Enter: () => {
      if (phase === 'config') handleRun()
      else if (progress.isConnected) handleViewConversation()
    },
  })

  // Guards the close-on-done effect so it fires exactly once per run.
  const closedOnDoneRef = useRef(false)
  useLaunchSteps(progress)

  // Done is done: the instant the conversation connects, focus it and close.
  // No countdown, no lingering timer to yank the user back if they tabbed away.
  // One-shot per run via closedOnDoneRef. Only re-select if not already focused
  // (rekey-follow may have moved the viewport there) and the user hasn't
  // navigated away mid-launch.
  useEffect(() => {
    // `phase` is the second lock: you cannot be DONE before you have STARTED.
    // Without it this fired on mount (the tracker reported the conversation the
    // user was viewing as "connected") and closed the dialog before it painted.
    if (phase !== 'launching') return
    if (!progress.isConnected || progress.hasError || closedOnDoneRef.current) return
    closedOnDoneRef.current = true
    focusLaunchTargetAndClose({
      launchConversationId: progress.launch.conversationId,
      spawnedConversation: progress.spawnedConversation,
      conversationAtLaunch: conversationAtLaunchRef.current,
      reason: 'project-board-launch-done',
      close: onClose,
    })
  }, [
    phase,
    progress.isConnected,
    progress.hasError,
    progress.launch.conversationId,
    progress.spawnedConversation,
    onClose,
  ])

  // fallow-ignore-next-line complexity
  async function handleRun() {
    if (phase !== 'config' || !spawnPath) return
    // An analyze run's "no commit, no worktree" must not become the next real
    // launch's remembered default.
    if (persistsDefaults(mode)) {
      saveRunTaskDefaults({
        model,
        effort,
        useWorktree,
        autoCommit,
        leaveRunning,
        includePartialMessages,
        maxBudgetUsd,
        timeout,
      })
    }
    setPhase('launching')
    conversationAtLaunchRef.current = useConversationsStore.getState().selectedConversationId
    closedOnDoneRef.current = false
    haptic('tap')

    const newJobId = crypto.randomUUID()
    setJobId(newJobId)
    progress.start([{ label: 'Sending spawn request...', status: 'active', ts: Date.now() }])

    const prompt = composeSpawnPrompt('', {
      taskWrapper: task,
      autoCommit,
      worktreeMergeBack: useWorktree,
      mode,
      epicRoster: epicRoster || undefined,
    })

    const spawnReq: SpawnRequest = {
      cwd: spawnPath,
      adHoc: true,
      adHocTaskId: task.slug,
      prompt,
      headless: true,
      model: (model || undefined) as SpawnRequest['model'],
      effort: (effort !== 'default' ? effort : undefined) as SpawnRequest['effort'],
      worktree: useWorktree ? branchName : undefined,
      leaveRunning: leaveRunning || undefined,
      // Prefixed for the read-only modes so three runs of the same card do not
      // sit in the conversation list under three identical names.
      name:
        deriveConversationName(
          { name: mode === 'work' ? undefined : `${modeSpec.action}: ${task.title}` },
          { slug: task.slug, title: task.title, status: task.status, priority: task.priority, tags: task.tags },
        ) ?? undefined,
      includePartialMessages: includePartialMessages || undefined,
      maxBudgetUsd: maxBudgetUsd ? Number(maxBudgetUsd) : undefined,
      env: applySubagentCapEnv(null, { maxConcurrentSubagents, maxSubagentSpawnDepth }) || undefined,
      jobId: newJobId,
    }
    const result = await sendSpawnRequest(spawnReq)
    if (result.ok) {
      haptic('success')
      const wid = result.conversationId
      spawnedConversationIdRef.current = wid
      progress.setSteps(prev => [
        ...prev.map(s =>
          s.status === 'active' ? { ...s, status: 'done' as const, detail: `agent-host=${wid.slice(0, 8)}` } : s,
        ),
        { label: 'Waiting for conversation...', status: 'active' as const, ts: Date.now() },
      ])
    } else {
      progress.setError(result.error)
    }
  }

  function handleViewConversation() {
    const sid = progress.launch.conversationId || progress.spawnedConversation?.id
    if (sid) {
      useConversationsStore.getState().selectConversation(sid, 'project-board-view-conversation')
      onClose()
    }
  }

  // fallow-ignore-next-line complexity
  function handleCopyDiagnostics() {
    const diag = buildSpawnDiagnostics({
      source: 'run-task-dialog',
      jobId,
      connectionId: spawnedConversationIdRef.current || progress.launch.conversationId || null,
      conversationId: progress.launch.conversationId ?? null,
      elapsedSec: progress.elapsed,
      error: progress.error || progress.launch.error || null,
      config: {
        cwd: spawnPath || undefined,
        model: (model || undefined) as SpawnRequest['model'],
        effort: (effort !== 'default' ? effort : undefined) as SpawnRequest['effort'],
        worktree: useWorktree ? branchName : undefined,
        leaveRunning: leaveRunning || undefined,
        maxBudgetUsd: maxBudgetUsd ? Number(maxBudgetUsd) : undefined,
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
      task: { slug: task.slug, title: task.title, status: task.status, priority: task.priority, tags: task.tags },
    })
    progress.copyToClipboard(JSON.stringify(diag, null, 2))
  }

  const displayError = progress.error || progress.launch.error

  return (
    <Dialog open={true} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-md rounded-lg p-0 gap-0 bg-surface-inset border-amber-500/30">
        <DialogTitle className="sr-only">Run Task: {task.title}</DialogTitle>
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-500/20">
          <Zap className="size-4 text-amber-400" />
          <span className="text-sm font-mono font-bold text-amber-400">
            {phase === 'config'
              ? `${modeSpec.action} Card`
              : progress.isComplete
                ? 'Task Complete'
                : progress.hasError
                  ? 'Launch Failed'
                  : 'Launching...'}
          </span>
          {phase === 'launching' && (
            <span className="text-[10px] font-mono text-fg-dim ml-auto mr-2 tabular-nums">{progress.elapsed}s</span>
          )}
        </div>

        {/* Task title */}
        <div className="px-4 py-3 border-b border-primary/12 space-y-2">
          {phase === 'config' && (
            <>
              <RunModeTabs mode={mode} onChange={switchMode} />
              <RunModeHint mode={mode} />
            </>
          )}
          <div className="text-xs font-mono text-foreground truncate">{task.title}</div>
          {phase === 'config' && task.body && (
            <div className="text-[10px] text-muted-foreground mt-1 line-clamp-2">{task.body.slice(0, 200)}</div>
          )}
        </div>

        {/* Phase 1: Config form */}
        {phase === 'config' && (
          <>
            <div className="px-4 py-3">
              <LaunchConfigFields
                value={{
                  model,
                  effort: effort === 'default' ? '' : effort,
                  includePartialMessages,
                  useWorktree,
                  worktreeName: branchName,
                  autoCommit,
                  leaveRunning,
                  maxBudgetUsd,
                  maxConcurrentSubagents,
                  maxSubagentSpawnDepth,
                  timeout,
                }}
                // Patch-fan-out idiom shared with spawn-dialog's applyFieldsPatch;
                // two new cap fields tipped this god-component handler past thresholds.
                // fallow-ignore-next-line complexity
                onChange={(patch: Partial<LaunchFieldsValue>) => {
                  if ('model' in patch) setModel(patch.model ?? '')
                  if ('effort' in patch) setEffort(patch.effort ? patch.effort : 'default')
                  if ('useWorktree' in patch) setUseWorktree(!!patch.useWorktree)
                  if ('worktreeName' in patch) setBranchName(patch.worktreeName ?? '')
                  if ('autoCommit' in patch) setAutoCommit(!!patch.autoCommit)
                  // fallow-ignore-next-line code-duplication
                  if ('leaveRunning' in patch) setLeaveRunning(!!patch.leaveRunning)
                  if ('maxBudgetUsd' in patch) setMaxBudgetUsd(patch.maxBudgetUsd ?? '')
                  if ('maxConcurrentSubagents' in patch) setMaxConcurrentSubagents(patch.maxConcurrentSubagents ?? '')
                  if ('maxSubagentSpawnDepth' in patch) setMaxSubagentSpawnDepth(patch.maxSubagentSpawnDepth ?? '')
                  if ('includePartialMessages' in patch) setIncludePartialMessages(!!patch.includePartialMessages)
                  if ('timeout' in patch) setTimeout_(patch.timeout ?? '30')
                }}
                show={{
                  model: true,
                  effort: true,
                  includePartialMessages: true,
                  worktree: true,
                  autoCommit: true,
                  leaveRunning: true,
                  maxBudgetUsd: true,
                  maxConcurrentSubagents: true,
                  maxSubagentSpawnDepth: true,
                  timeout: true,
                }}
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-primary/12">
              <button
                type="button"
                onClick={onClose}
                className="flex items-center gap-1.5 px-3 py-1 text-xs font-mono text-muted-foreground hover:text-foreground"
              >
                Cancel
                <Kbd className="opacity-60">Esc</Kbd>
              </button>
              <button
                type="button"
                onClick={handleRun}
                disabled={!spawnPath}
                className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold font-mono bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors disabled:opacity-50"
              >
                <Zap className="size-3" />
                {modeSpec.action}
                <Kbd className="bg-amber-500/20 text-amber-400/70">↵</Kbd>
              </button>
            </div>
          </>
        )}

        {/* Phase 2: Launch monitor */}
        {phase === 'launching' && (
          <>
            <div className="px-4 py-3">
              <LaunchStepList steps={progress.steps} />
            </div>

            {displayError && (
              <div className="px-4 py-2 border-t border-red-500/20">
                <LaunchErrorBanner
                  error={displayError}
                  copied={progress.copied}
                  onCopy={handleCopyDiagnostics}
                  copyLabel="Copy diagnostics"
                />
              </div>
            )}

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-primary/12">
              <LaunchFooterActions
                isConnected={progress.isConnected}
                isComplete={progress.isComplete}
                hasError={progress.hasError}
                onViewConversation={handleViewConversation}
                onClose={onClose}
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
