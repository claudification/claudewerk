/**
 * `spawn_conversation` MCP handler.
 *
 * Two-phase: (1) a `channel_spawn` broker-RPC that returns a conversationId +
 * jobId, then (2) a rendezvous wait for the spawned host to boot. Optional
 * job-event progress streaming bridges the gap. Lifted verbatim from
 * claude-agent-host (behavior-preserving) onto the injected `HostRpcContext`.
 */

import { randomUUID } from 'node:crypto'
import type { AgentHostMessage } from '../../shared/protocol'
import type { HostRpcContext } from './context'

const SPAWN_RENDEZVOUS_MS = 45_000

export async function handleSpawnConversation(
  ctx: HostRpcContext,
  spawnParams: Record<string, unknown>,
  onProgress?: (event: Record<string, unknown>) => void,
) {
  if (!ctx.transport.isConnected()) return { ok: false, error: 'Not connected to broker' }

  const { pending } = ctx
  const requestId = randomUUID()
  const spawnResult = await new Promise<{ ok: boolean; error?: string; conversationId?: string; jobId?: string }>(
    resolve => {
      const timeout = setTimeout(() => {
        if (pending.pendingSpawnRequestId === requestId) {
          pending.pendingSpawnResult = null
          pending.pendingSpawnRequestId = null
        }
        resolve({ ok: false, error: 'Timeout' })
      }, 15000)
      pending.pendingSpawnRequestId = requestId
      pending.pendingSpawnResult = result => {
        clearTimeout(timeout)
        pending.pendingSpawnResult = null
        pending.pendingSpawnRequestId = null
        resolve(result)
      }
      ctx.transport.send({ type: 'channel_spawn', requestId, ...spawnParams } as unknown as AgentHostMessage)
    },
  )

  if (!spawnResult.ok) return spawnResult

  const jobId = spawnResult.jobId
  ctx.diag(
    'channel',
    `spawn_session: ${(spawnParams as { cwd?: string }).cwd} mode=${(spawnParams as { mode?: string }).mode || 'default'} conversationId=${spawnResult.conversationId?.slice(0, 8)} job=${jobId?.slice(0, 8)}`,
  )

  if (jobId && onProgress) {
    pending.launchJobListeners.set(jobId, onProgress)
    ctx.transport.send({ type: 'subscribe_job', jobId } as unknown as AgentHostMessage)
  }

  function cleanupJob() {
    if (!jobId) return
    pending.launchJobListeners.delete(jobId)
    ctx.transport.send({ type: 'unsubscribe_job', jobId } as unknown as AgentHostMessage)
  }

  if (spawnResult.conversationId) {
    try {
      const wid = spawnResult.conversationId
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.pendingRendezvous.delete(wid)
          reject(new Error(`Rendezvous timeout (${SPAWN_RENDEZVOUS_MS / 1000}s)`))
        }, SPAWN_RENDEZVOUS_MS)
        pending.pendingRendezvous.set(wid, {
          resolve: msg => {
            clearTimeout(timer)
            resolve(msg)
          },
          reject: (e: string) => {
            clearTimeout(timer)
            reject(new Error(e))
          },
        })
      })
      const conversation = result.conversation as Record<string, unknown> | undefined
      ctx.diag(
        'channel',
        `spawn_conversation: rendezvous resolved cc-session=${(result.ccSessionId as string)?.slice(0, 8)}`,
      )
      cleanupJob()
      return { ok: true, conversationId: spawnResult.conversationId, jobId, conversation }
    } catch (err) {
      ctx.diag('channel', `spawn_conversation: rendezvous failed: ${err instanceof Error ? err.message : err}`)
      cleanupJob()
      return { ok: true, conversationId: spawnResult.conversationId, jobId, timedOut: true }
    }
  }

  cleanupJob()
  return { ok: true, conversationId: spawnResult.conversationId, jobId }
}
