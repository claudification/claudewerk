/**
 * Fork a conversation from a specific transcript message into a NEW conversation.
 *
 * A fork replays the SOURCE CC session up to `atMessageUuid`
 * (`--resume-session-at`, omitted = fork from HEAD) and branches it into a fresh
 * CC session (`--fork-session`). The source conversation is left untouched; the
 * fork is a lineage child (`parentConversationId`) that always boots headless via
 * the classic rclaude resume path -- so daemon/PTY sources fork uniformly (CC
 * session JSONL is transport-agnostic and the sentinel revive handler routes
 * non-acp/opencode revives through the same classic resume).
 *
 * Shared by the HTTP route (`POST /conversations/:id/fork`) and the MCP
 * `fork_conversation` tool so the fork policy lives in exactly one place.
 */

import { randomUUID } from 'node:crypto'
import type { Conversation } from '../shared/protocol'
import { resolveSpawnConfig } from '../shared/spawn-defaults'
import type { SpawnRequest } from '../shared/spawn-schema'
import { buildReviveMessage, conversationHasCcSession } from './build-revive'
import type { ConversationStore } from './conversation-store'
import { getGlobalSettings } from './global-settings'
import { getProjectSettings } from './project-settings'
import { computeSpawnLineage } from './spawn-lineage'

export type ForkResult =
  | { ok: true; conversationId: string; name: string }
  | { ok: false; error: string; statusCode: number }

/** Resolve the fork's launch config from the source's (launch config > project >
 *  global defaults). Extracted so `forkConversation` stays low-complexity. */
function resolveForkLaunchConfig(source: Conversation) {
  const lc = source.launchConfig
  return resolveSpawnConfig(
    {
      cwd: source.project,
      model: lc?.model as SpawnRequest['model'] | undefined,
      effort: lc?.effort as SpawnRequest['effort'] | undefined,
      bare: lc?.bare,
      repl: lc?.repl,
      permissionMode: lc?.permissionMode as SpawnRequest['permissionMode'] | undefined,
      autocompactPct: lc?.autocompactPct,
      maxBudgetUsd: lc?.maxBudgetUsd,
    },
    getProjectSettings(source.project),
    getGlobalSettings(),
  )
}

export function forkConversation(
  conversationStore: ConversationStore,
  opts: { sourceId: string; atMessageUuid?: string },
): ForkResult {
  const source = conversationStore.getConversation(opts.sourceId)
  if (!source) return { ok: false, error: 'Conversation not found', statusCode: 404 }

  // A fork replays the source CC session, so the source must have booted at least
  // once. `conversationHasCcSession` is the boundary-safe presence check -- the
  // broker core never reads the ccSessionId value itself.
  if (!conversationHasCcSession(source))
    return { ok: false, error: 'Source conversation has no CC session to fork from (it never booted)', statusCode: 400 }

  const sentinel = conversationStore.getSentinel()
  if (!sentinel) return { ok: false, error: 'No sentinel connected', statusCode: 503 }

  const atMessageUuid = opts.atMessageUuid || undefined
  const newId = randomUUID()
  const lineage = computeSpawnLineage(conversationStore, opts.sourceId, newId, 'fork')

  const { model, effort, bare, repl, permissionMode, autocompactPct, maxBudgetUsd } = resolveForkLaunchConfig(source)

  // Create the forked row up front (a lineage child of the source) so it shows in
  // the sidebar the moment the fork is requested. Title gets a "(fork)" suffix,
  // pinned (titleUserSet) against the initial-transcript title reset.
  const forkTitle = `${source.title || opts.sourceId.slice(0, 8)} (fork)`
  const forked = conversationStore.createConversation(
    newId,
    source.project,
    model || source.model || '',
    [],
    source.capabilities ?? ['terminal'],
    lineage,
  )
  forked.title = forkTitle
  forked.titleUserSet = true
  forked.launchConfig = source.launchConfig
  // Fork origin -- broker-written display data in the opaque meta bag (the same
  // pattern the daemon backend uses for DAEMON_META). `parentConversationId`
  // carries the lineage; this records WHICH message the fork was taken at so the
  // UI can render a "Forked from <source>" banner without a schema change.
  forked.agentHostMeta = {
    ...(forked.agentHostMeta ?? {}),
    forkedFromConversationId: opts.sourceId,
    ...(atMessageUuid ? { forkedFromMessageUuid: atMessageUuid } : {}),
  }
  conversationStore.persistConversationById(newId)

  sentinel.send(
    JSON.stringify(
      buildReviveMessage(source, newId, {
        headless: true,
        // Force the classic rclaude host: a fork boots headless regardless of the
        // source's transport (daemon/PTY), so the revive must not carry the
        // source's agentHostType through to the sentinel's per-type routing.
        agentHostType: 'claude',
        effort,
        model,
        bare: bare || undefined,
        repl: repl || undefined,
        permissionMode,
        autocompactPct,
        maxBudgetUsd,
        forkSession: true,
        resumeSessionAt: atMessageUuid,
      }),
    ),
  )

  console.log(
    `[fork] source=${opts.sourceId.slice(0, 8)} new=${newId.slice(0, 8)} at=${atMessageUuid?.slice(0, 8) ?? 'HEAD'} ` +
      `headless model=${model ?? '-'}`,
  )
  return { ok: true, conversationId: newId, name: forkTitle }
}
