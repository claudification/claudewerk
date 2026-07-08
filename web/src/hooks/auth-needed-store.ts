/**
 * Which conversations are showing the "profile needs re-login" hint.
 *
 * Driven by the ephemeral `conversation_auth_needed` message (a headless
 * inference 401). External-store pattern like thinking-progress-store -- the hint
 * is derived state, never persisted. Cleared when the Login modal completes or
 * when the conversation produces a fresh assistant/result message (auth
 * recovered, the retry loop self-healed).
 */

import { createExternalStoreSignal } from './external-store-utils'

export interface AuthNeeded {
  errorStatus: number
  detail?: string
  at: number
}

const byConversation = new Map<string, AuthNeeded>()
const signal = createExternalStoreSignal()

export function setAuthNeeded(conversationId: string, info: AuthNeeded): void {
  byConversation.set(conversationId, info)
  signal.bump()
}

export function clearAuthNeeded(conversationId: string): void {
  if (byConversation.delete(conversationId)) signal.bump()
}

export function getAuthNeeded(conversationId: string): AuthNeeded | undefined {
  return byConversation.get(conversationId)
}

export const subscribe = signal.subscribe
export const getVersion = signal.getVersion
