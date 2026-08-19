/**
 * AskUserQuestion relay: agent host <-> control panel.
 *
 * Split out of `permissions.ts`, which had grown into a grab-bag of three
 * unrelated relays (tool permissions, AskUserQuestion, clipboard capture).
 *
 * Pending state is mirrored onto the conversation so a reconnecting dashboard
 * rehydrates the question card, and cleared on answer/timeout so it does not
 * rehydrate a stale one.
 */

import type { AskQuestionDismiss } from '../../shared/protocol'
import { cancelAskNotify, scheduleAskNotify } from '../attention-notify'
import type { MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, DASHBOARD_ROLES, registerHandlers } from '../message-router'
import { forwardToAgentHost, mirrorPendingInteraction } from './relay-helpers'

/** Drop the pending question + its attention flag. Shared by the answer and
 *  timeout paths, which differ only in whether anything is forwarded to CC. */
function clearPendingAsk(ctx: Parameters<MessageHandler>[0], conversationId: string): void {
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (!conversation) return
  delete conversation.pendingAskQuestion
  if (conversation.pendingAttention?.type === 'ask') {
    delete conversation.pendingAttention
  }
  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)
}

/** Tell every other subscriber the question is resolved so the card disappears
 *  on every session, not just the one that answered. */
function broadcastAskDismiss(ctx: Parameters<MessageHandler>[0], conversationId: string, toolUseId: string): void {
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation?.project) return
  ctx.broadcastScoped(
    { type: 'ask_dismiss', conversationId, toolUseId } satisfies AskQuestionDismiss,
    conversation.project,
  )
}

// Agent host -> dashboard (broadcast + store for reconnect recovery).
const askQuestion: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return

  mirrorPendingInteraction(
    ctx,
    conversationId,
    { type: 'ask', toolName: 'AskUserQuestion', timestamp: Date.now() },
    conv => {
      conv.pendingAskQuestion = {
        toolUseId: data.toolUseId as string,
        questions: data.questions as unknown[],
        timestamp: Date.now(),
      }
    },
  )

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation?.project) {
    ctx.log.debug(`[ask] dropping question: no project on ${conversationId.slice(0, 8)}`)
    return
  }
  ctx.broadcastScoped(
    {
      type: 'ask_question',
      conversationId,
      toolUseId: data.toolUseId,
      questions: data.questions,
    },
    conversation.project,
  )

  const firstQuestion = (data.questions as Array<{ question: string }>)?.[0]?.question
  scheduleAskNotify({
    conversationId,
    project: conversation.project,
    question: firstQuestion || 'Question waiting',
  })

  ctx.log.debug(
    `[ask] Question: ${(data.toolUseId as string)?.slice(0, 12)} ${(data.questions as unknown[])?.length || 0}q`,
  )
}

// Dashboard -> agent host (forward + clear stored state).
const askAnswer: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const toolUseId = data.toolUseId as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (conversation) ctx.requirePermission('chat', conversation.project)

  const sent = forwardToAgentHost(
    ctx,
    conversationId,
    { type: 'ask_answer', toolUseId, answers: data.answers, annotations: data.annotations, skip: data.skip },
    'ask',
  )
  if (sent) ctx.log.debug(`[ask] Answer: ${toolUseId?.slice(0, 12)} ${data.skip ? 'SKIP' : 'answered'}`)

  clearPendingAsk(ctx, conversationId)
  cancelAskNotify(conversationId)
  broadcastAskDismiss(ctx, conversationId, toolUseId)
}

// Agent host -> broker (headless, no user response within deadline). Same
// cleanup as askAnswer(skip=true) but nothing to forward -- the agent host
// already unblocked CC before emitting this.
const askQuestionTimeout: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const toolUseId = data.toolUseId as string

  clearPendingAsk(ctx, conversationId)
  cancelAskNotify(conversationId)
  broadcastAskDismiss(ctx, conversationId, toolUseId)

  ctx.log.info(`[ask] Timeout: ${toolUseId?.slice(0, 12)} on ${conversationId?.slice(0, 8)} -- CC unblocked with skip`)
}

export function registerAskQuestionHandlers(): void {
  registerHandlers({ ask_question: askQuestion, ask_question_timeout: askQuestionTimeout }, AGENT_HOST_ONLY)
  registerHandlers({ ask_answer: askAnswer }, DASHBOARD_ROLES)
}
