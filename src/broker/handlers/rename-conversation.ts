/**
 * Conversation rename -- the single rename surface.
 *
 * A rename has TWO writers to keep in step: the broker's own conversation row,
 * and CC's idea of its own title (which it stores as a `custom-title` control
 * line in its JSONL). Only writing the first is what made renames look
 * unpersisted: every resync replays that JSONL and CC's stale copy won. So the
 * broker persists, broadcasts, AND pushes the new title down to the live agent
 * host so CC renames itself.
 */

import type { TitleOrigin } from '../../shared/protocol'
import { slugify } from '../address-book'
import { applyTitleWrite } from '../conversation-store/title-authority'
import { recordRetiredSlug } from '../former-slugs'
import { GuardError, type HandlerContext, type MessageHandler } from '../handler-context'
import { DASHBOARD_ROLES, detectRole, registerHandlers } from '../message-router'
import { resolveConversationSocket } from './socket-routing'

type Conversation = NonNullable<ReturnType<HandlerContext['conversations']['getConversation']>>

/**
 * Tell the running CC instance to rename ITSELF (headless: `rename_session`
 * control request; PTY: `/rename`). Without this the broker's title and CC's
 * title are two copies of one fact that never sync, and CC's copy -- replayed
 * from its JSONL on every reconnect -- reverts the rename.
 *
 * Best-effort by design: no live host (ended / not yet booted / daemon worker)
 * just means CC keeps its old title, and the `isInitial` guard in
 * `handleCustomTitleEntry` stops that stale title from winning. A cleared title
 * pushes nothing -- the broker falls back to an auto name, CC keeps its own.
 */
function pushTitleToAgentHost(ctx: HandlerContext, conversationId: string, title: string | undefined): void {
  if (!title) return
  const ws = resolveConversationSocket(ctx, conversationId)
  if (!ws) {
    ctx.log.debug(`[rename] ${conversationId.slice(0, 8)} no live agent host -- CC title not synced`)
    return
  }
  ws.send(JSON.stringify({ type: 'control', action: 'set_title', title }))
  ctx.log.info(`[rename] ${conversationId.slice(0, 8)} pushed set_title="${title}" to agent host`)
}

/**
 * Apply a title/description change to a conversation, then persist + broadcast.
 * Shared by the dashboard rename path and the agent-host (self / benevolent)
 * rename path so the mutation rules stay in one place. An empty `name` clears
 * the user-set title and reverts to the auto-generated name; any non-empty name
 * (whether set by a human OR a benevolent agent) pins the title so CC's
 * auto-titler will not clobber it.
 *
 * WHO WINS is `title-authority`'s call, not this function's -- including the
 * "nothing actually changed" verdict, which is load-bearing: the rename we push
 * down to CC comes back as a `/rename` echo, and applying it again would push
 * again, forever. Rejecting the unchanged echo is what terminates that loop.
 */
interface TitleWriteRequest {
  origin: TitleOrigin
  at?: number
}

/** Why a rejected write was rejected, with both sides of the comparison, so a
 *  future reader can tell a pin from a stale replay from a no-op echo. */
function logRejected(
  ctx: HandlerContext,
  conversation: Conversation,
  conversationId: string,
  name: string | undefined,
  write: TitleWriteRequest,
  reason: string,
): void {
  ctx.log.debug(
    `[rename] ${conversationId.slice(0, 8)} ignored origin=${write.origin} at=${write.at ?? '-'} ` +
      `name="${name || '(cleared)'}" -- ${reason} (title "${conversation.title}" ` +
      `origin=${conversation.titleOrigin ?? '-'} at=${conversation.titleSetAt ?? '-'})`,
  )
}

/** Retire the slug the conversation answered to BEFORE this rename, so peers
 *  that cached the OLD name keep routing for the decay window. Only a CUSTOM old
 *  title is worth retaining: an empty one meant the addressable slug was the
 *  id-slice fallback, which the stable-id resolver still resolves -- no alias
 *  needed. (plan-conversation-rename Phase 2b) */
function retireOldSlug(conversation: Conversation, oldSlug: string): void {
  const newSlug = slugify(conversation.title || conversation.id.slice(0, 8))
  if (oldSlug !== newSlug) {
    conversation.formerSlugs = recordRetiredSlug(conversation.formerSlugs, oldSlug, newSlug, Date.now())
  }
}

/** A description edit rides the same verb and is worth committing even when the
 *  title write itself is rejected (renaming to the SAME name while editing the
 *  description is an ordinary thing to do from the panel). */
function isDescriptionChanged(conversation: Conversation, description: string | undefined): boolean {
  return description !== undefined && (description || undefined) !== conversation.description
}

/** Persist + broadcast a decided rename. Slug retirement belongs here because it
 *  must see the title AFTER the write but the old slug from BEFORE it. */
function commitRename(
  ctx: HandlerContext,
  conversation: Conversation,
  conversationId: string,
  description: string | undefined,
  oldSlug: string,
): void {
  if (description !== undefined) conversation.description = description || undefined
  retireOldSlug(conversation, oldSlug)
  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)
}

function applyRename(
  ctx: HandlerContext,
  conversation: Conversation,
  conversationId: string,
  name: string | undefined,
  description: string | undefined,
  write: TitleWriteRequest,
): boolean {
  const oldSlug = conversation.title ? slugify(conversation.title) : ''
  const verdict = applyTitleWrite(conversation, { title: name, origin: write.origin, at: write.at }, Date.now())

  if (!verdict.accept && !isDescriptionChanged(conversation, description)) {
    logRejected(ctx, conversation, conversationId, name, write, verdict.reason)
    return false
  }
  if (verdict.accept && verdict.clamped) {
    ctx.log.info(`[rename] ${conversationId.slice(0, 8)} CLOCK SKEW -- at=${write.at} is ahead of us, clamped to now`)
  }

  commitRename(ctx, conversation, conversationId, description, oldSlug)
  // Only push a title CC does not already have. A rename that ORIGINATED inside
  // CC needs no push back, and pushing it would restart the echo.
  if (verdict.accept && write.origin !== 'cc-observed') pushTitleToAgentHost(ctx, conversationId, conversation.title)
  return true
}

/** The wire's `origin`, narrowed. An unknown or absent value means a caller that
 *  predates title provenance -- treat it as a deliberate human rename, which is
 *  what every existing caller of this verb actually is. */
function readOrigin(raw: unknown): TitleOrigin {
  return raw === 'agent' || raw === 'cc-auto' || raw === 'cc-observed' ? raw : 'user'
}

export const renameConversation: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const name = (data.name as string)?.trim()
  const description = typeof data.description === 'string' ? data.description.trim() : undefined
  const origin = readOrigin(data.origin)
  // A dated write is what makes replay protection work. An undated one (every
  // panel rename) is stamped with the broker's clock at apply time.
  const at = typeof data.at === 'number' && Number.isFinite(data.at) ? data.at : undefined
  if (!conversationId) throw new GuardError('Missing conversationId')

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')

  // Authz splits by caller role. Dashboards/share viewers go through the
  // project chat-permission check (a no-op for agent-host, which is precisely
  // why agent-host needs its own gate below). An agent host may rename its OWN
  // conversation freely (it owns it); renaming ANOTHER conversation is a
  // cross-conversation mutation and requires benevolent trust, consistent with
  // configure_conversation / control_conversation.
  const role = detectRole(ctx.ws.data)
  if (role === 'agent-host') {
    const isSelf = ctx.ws.data.conversationId === conversationId
    if (!isSelf) ctx.requireBenevolent()
  } else {
    ctx.requirePermission('chat', conversation.project)
  }

  const applied = applyRename(ctx, conversation, conversationId, name, description, { origin, at })
  ctx.log.debug(
    `[rename] ${conversationId.slice(0, 8)} role=${role} self=${ctx.ws.data.conversationId === conversationId} ` +
      `origin=${origin} at=${at ?? '-'} applied=${applied} ` +
      `name="${name || '(cleared)'}"${description !== undefined ? ` desc-set` : ''}`,
  )
  ctx.reply({ type: 'rename_conversation_result', ok: true })
}

/** rename_conversation is NOT dashboard-only: an agent host may rename its own
 *  conversation (self), and a benevolent agent host may rename any conversation
 *  (gated inside the handler). Dashboards/share viewers keep the chat-permission
 *  path. Hence the wider role allowlist. */
export function registerRenameHandlers(): void {
  registerHandlers({ rename_conversation: renameConversation }, ['agent-host', ...DASHBOARD_ROLES])
}
