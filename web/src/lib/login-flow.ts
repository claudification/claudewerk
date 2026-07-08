/**
 * The 3-step Claude.ai OAuth flow, driven over cc_control from the dashboard.
 *
 *   1. claude_authenticate      -> authorize URL (we use the MANUAL url, whose
 *      redirect shows the code; the automatic url points at a localhost server
 *      on the remote agent host, unreachable from the user's browser).
 *   2. user opens the url, authorizes, copies the response.
 *   3. claude_oauth_callback    -> completes the exchange, returns the account.
 *
 * `state` is issued by CC inside the authorize URL; we stash it, then use it to
 * CSRF-check whatever the user pastes back before completing. Pure parsing lives
 * in login-parse.ts (unit-tested); this module is just the WS orchestration.
 */

import { sendControlCommand } from './control-command'
import { type AuthUrl, extractAccount, extractAuthUrl, type LoginAccount, validatePastedCode } from './login-parse'

export type { LoginAccount } from './login-parse'
export type LoginStart = AuthUrl

/** Fire claude_authenticate and pull the manual authorize URL + its state. */
export async function startLogin(conversationId: string): Promise<LoginStart> {
  const res = await sendControlCommand(conversationId, 'claude_authenticate', { loginWithClaudeAi: true })
  if (!res.ok) throw new Error(res.error || 'claude_authenticate failed')
  return extractAuthUrl(res.response)
}

/**
 * Complete the login with the pasted response. Verifies the pasted state (when
 * present) against the one we issued -- a mismatch is a CSRF/stale-URL reject --
 * then fires claude_oauth_callback with the ISSUED state.
 */
export async function completeLogin(
  conversationId: string,
  pasted: string,
  issuedState: string,
): Promise<LoginAccount> {
  const code = validatePastedCode(pasted, issuedState)
  const res = await sendControlCommand(conversationId, 'claude_oauth_callback', {
    authorizationCode: code,
    state: issuedState,
  })
  if (!res.ok) throw new Error(res.error || 'claude_oauth_callback failed')
  return extractAccount(res.response)
}
