import type { ChatApiConnection } from '@shared/chat-api-types'
import type { OpenCodeToolPermission, SpawnRequest } from '@shared/spawn-schema'
import { type RefObject, useCallback } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { DaemonRosterEntry } from '@/hooks/use-daemon-roster'
import type { useLaunchProgress } from '@/hooks/use-launch-progress'
import { sendSpawnRequest } from '@/hooks/use-spawn'
import { parseEnvText } from '@/lib/env-parse'
import { haptic } from '@/lib/utils'
import type { BackendKind } from './backend-select'
import {
  buildDaemonSpawnFields,
  type DaemonMode,
  type DaemonModeFormValue,
  validateDaemonAttach,
  validateDaemonModeForm,
} from './daemon-launch'
import type { ClaudeTransport } from './process-model'

export interface SpawnActionOptions {
  path: string
  mkdir?: boolean
  sentinel?: string
}

export interface SpawnActionContext {
  state: { open: boolean; options: SpawnActionOptions | null }
  phase: 'config' | 'launching'
  effectivePath: string

  // shared form state
  name: string
  description: string
  sentinelProfile: string
  sentinelPool: string

  // claude-family fields
  headless: boolean
  bare: boolean
  repl: boolean
  model: string
  effort: string
  agent: string
  advisor: string
  permissionMode: string
  autocompactPct: number | ''
  maxBudgetUsd: string
  resumeId: string
  includePartialMessages: boolean
  useWorktree: boolean
  worktreeName: string
  envText: string

  // backend dispatch
  backend: BackendKind
  transport: ClaudeTransport
  isDaemonTransport: boolean
  chatConnectionId: string
  chatConnections: ChatApiConnection[]
  openCodeModel: string
  openCodeToolPermission: OpenCodeToolPermission
  hermesGatewayId: string

  // daemon launch
  daemonMode: DaemonMode
  daemonForm: DaemonModeFormValue
  daemonAttach: DaemonRosterEntry | null

  // progress + setters
  progress: ReturnType<typeof useLaunchProgress>
  setPhase: (p: 'config' | 'launching') => void
  setJobId: (id: string) => void
  setWrapperId: (id: string | null) => void
  setDaemonErrors: (errs: string[]) => void
  setConfigTab: (t: 'basic' | 'advanced') => void

  conversationAtSpawnRef: RefObject<string | null>
}

function buildDaemonSpawnRequest(
  ctx: SpawnActionContext,
  newJobId: string,
): { req: SpawnRequest } | { errors: string[] } {
  const {
    daemonMode,
    daemonAttach,
    daemonForm,
    effectivePath,
    state,
    name,
    description,
    sentinelProfile,
    sentinelPool,
  } = ctx
  const daemonValidation =
    daemonMode === 'attach' ? validateDaemonAttach(daemonAttach?.short) : validateDaemonModeForm(daemonMode, daemonForm)
  if (daemonValidation.length) return { errors: daemonValidation }
  const isAttach = daemonMode === 'attach'
  if (!state.options) return { errors: ['Spawn dialog has no options'] }
  return {
    req: {
      cwd: isAttach && daemonAttach ? daemonAttach.cwd : effectivePath,
      mkdir: isAttach ? false : state.options.mkdir || false,
      name: name.trim() || undefined,
      description: description.trim() || undefined,
      sentinel: (isAttach ? daemonAttach?.sentinelAlias : undefined) || state.options.sentinel || undefined,
      profile: sentinelProfile || undefined,
      pool: sentinelPool || undefined,
      jobId: newJobId,
      ...buildDaemonSpawnFields({ mode: daemonMode, form: daemonForm, attachShort: daemonAttach?.short }),
    },
  }
}

function buildStandardSpawnRequest(
  ctx: SpawnActionContext,
  newJobId: string,
): { req: SpawnRequest } | { envError: true } {
  const {
    effectivePath,
    state,
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
    advisor,
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
    chatConnectionId,
    chatConnections,
    openCodeModel,
    openCodeToolPermission,
    hermesGatewayId,
  } = ctx
  const [parsedEnv, errors] = parseEnvText(envText)
  if (errors.length) return { envError: true }
  if (!state.options) return { envError: true }
  const trimmedResumeId = resumeId.trim()
  return {
    req: {
      cwd: effectivePath,
      mkdir: state.options.mkdir || false,
      mode: trimmedResumeId ? 'resume' : undefined,
      resumeId: trimmedResumeId || undefined,
      headless,
      bare: bare || undefined,
      repl: repl || undefined,
      name: name.trim() || undefined,
      description: description.trim() || undefined,
      model: (model || undefined) as SpawnRequest['model'],
      effort: (effort || undefined) as SpawnRequest['effort'],
      agent: agent.trim() || undefined,
      advisor: advisor.trim() || undefined,
      permissionMode: (permissionMode || undefined) as SpawnRequest['permissionMode'],
      autocompactPct: autocompactPct === '' ? undefined : autocompactPct,
      maxBudgetUsd: maxBudgetUsd ? Number(maxBudgetUsd) : undefined,
      worktree: useWorktree && worktreeName.trim() ? worktreeName.trim() : undefined,
      includePartialMessages: includePartialMessages || undefined,
      sentinel: state.options.sentinel || undefined,
      profile: sentinelProfile || undefined,
      pool: sentinelPool || undefined,
      env: parsedEnv || undefined,
      jobId: newJobId,
      backend: backend !== 'claude' ? backend : undefined,
      transport: backend === 'claude' ? transport : undefined,
      chatConnectionId: backend === 'chat-api' ? chatConnectionId || undefined : undefined,
      chatConnectionName:
        backend === 'chat-api' ? chatConnections.find(a => a.id === chatConnectionId)?.name : undefined,
      openCodeModel: backend === 'opencode' ? openCodeModel.trim() || undefined : undefined,
      toolPermission: backend === 'opencode' ? openCodeToolPermission : undefined,
      gatewayId: backend === 'hermes' ? hermesGatewayId || undefined : undefined,
    },
  }
}

export function useSpawnAction(ctx: SpawnActionContext): () => Promise<void> {
  return useCallback(async () => {
    if (!ctx.state.options || ctx.phase !== 'config') return

    const newJobId = crypto.randomUUID()
    let spawnReq: SpawnRequest

    if (ctx.isDaemonTransport) {
      const built = buildDaemonSpawnRequest(ctx, newJobId)
      if ('errors' in built) {
        ctx.setDaemonErrors(built.errors)
        haptic('error')
        return
      }
      ctx.setDaemonErrors([])
      spawnReq = built.req
    } else {
      const built = buildStandardSpawnRequest(ctx, newJobId)
      if ('envError' in built) {
        ctx.setConfigTab('advanced')
        haptic('error')
        return
      }
      spawnReq = built.req
    }

    ctx.setPhase('launching')
    ctx.conversationAtSpawnRef.current = useConversationsStore.getState().selectedConversationId
    haptic('tap')
    ctx.setJobId(newJobId)
    ctx.progress.start([{ label: 'Sending spawn request', status: 'active', ts: Date.now() }])

    const result = await sendSpawnRequest(spawnReq)
    if (result.ok) {
      haptic('success')
      ctx.setWrapperId(result.conversationId)
      ctx.progress.setSteps(prev => [
        ...prev.map(s =>
          s.status === 'active'
            ? { ...s, status: 'done' as const, detail: `agent-host=${result.conversationId.slice(0, 8)}` }
            : s,
        ),
        { label: 'Waiting for conversation...', status: 'active' as const, ts: Date.now() },
      ])
    } else {
      ctx.progress.setError(result.error)
      haptic('error')
    }
    // The callback intentionally re-runs whenever any ctx field changes; the
    // caller is expected to memoize / pass-through. We depend on the ctx
    // object identity rather than spreading 30+ deps.
  }, [ctx])
}

// Exported for tests; pure builders given a context-shaped object.
export const _buildStandardSpawnRequest = buildStandardSpawnRequest
export const _buildDaemonSpawnRequest = buildDaemonSpawnRequest
