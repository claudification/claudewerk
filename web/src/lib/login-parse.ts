/**
 * Pure parsing helpers for the Claude login flow -- no I/O, no React, no WS.
 * Split out of login-flow.ts so the branch-heavy extraction is unit-tested in
 * isolation and the orchestration (startLogin/completeLogin) stays thin.
 */

export interface AuthUrl {
  url: string
  state: string
}

export interface LoginAccount {
  email?: string
  subscriptionType?: string
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** Pull the manual authorize URL + its `state` from a claude_authenticate
 *  response (CC may nest it under `response`). Throws if no URL is present. */
export function extractAuthUrl(response: unknown): AuthUrl {
  const resp = asRecord(response)
  const inner = asRecord(resp.response)
  const url = (resp.manualUrl ?? inner.manualUrl ?? resp.url ?? inner.url) as string | undefined
  if (!url) throw new Error('authenticate returned no authorization URL')
  let state = ''
  try {
    state = new URL(url).searchParams.get('state') ?? ''
  } catch {
    state = ''
  }
  return { url, state }
}

/** Split CC's `code#state` blob. The manual redirect page hands the user ONE
 *  string with the state glued on after a `#`; CC's own TUI splits on the first
 *  `#` before exchanging, and `/oauth/token` 400s on the whole thing, so the
 *  fragment MUST come off before the code goes on the wire. */
function splitCodeHash(raw: string): { code: string; state?: string } {
  const hash = raw.indexOf('#')
  if (hash === -1) return { code: raw }
  return { code: raw.slice(0, hash), state: raw.slice(hash + 1) || undefined }
}

/** Extract the auth code (and any embedded state) from what the user pasted --
 *  the full callback URL, a bare `code#state` blob, or a naked code. */
export function parsePastedCode(input: string): { code: string; state?: string } {
  const trimmed = input.trim()
  if (!trimmed.includes('code=')) return splitCodeHash(trimmed)
  const qs = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?') + 1) : trimmed
  const params = new URLSearchParams(qs)
  const split = splitCodeHash(params.get('code') ?? trimmed)
  return { code: split.code, state: params.get('state') ?? split.state }
}

/** Validate a pasted response against the issued state and return the code.
 *  Throws on an empty code or a state mismatch (CSRF / stale-URL reject). */
export function validatePastedCode(pasted: string, issuedState: string): string {
  const { code, state } = parsePastedCode(pasted)
  if (!code) throw new Error('no authorization code found in the pasted text')
  if (state && issuedState && state !== issuedState) {
    throw new Error('state mismatch -- paste came from a different login attempt')
  }
  return code
}

/** The account block from a claude_oauth_callback response, narrowed. */
export function extractAccount(response: unknown): LoginAccount {
  const account = asRecord(asRecord(response).account)
  return {
    email: typeof account.email === 'string' ? account.email : undefined,
    subscriptionType: typeof account.subscriptionType === 'string' ? account.subscriptionType : undefined,
  }
}

/** One-line display of the logged-in account. */
export function formatAccount(account: LoginAccount): string {
  if (!account.email) return 'Logged in'
  return account.subscriptionType ? `${account.email} -- ${account.subscriptionType}` : account.email
}
