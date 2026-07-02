/**
 * ATTENTION POLICY -- which fleet signals get to wake the dispatcher (N2,
 * plan-dispatcher-nextgen.md). Pure + clock-injectable so the noise rules are
 * unit-testable: the whole point of this layer is that the dispatcher becomes
 * a sentinel WITHOUT becoming a nuisance.
 *
 * Three signal sources, each with its own dedupe key + cooldown:
 *  - needs_you  : a conversation TRANSITIONS into needs_you/blocked (repeats and
 *                 restarts re-reporting the same state do not re-fire).
 *  - git_alert  : an escalation (at-risk/unpushed/stalled) newly appears for a
 *                 project. Long cooldown -- these are chronic by nature; the
 *                 dispatcher turn decides push-or-hold with fleet context.
 *  - contended  : a claim/stake target newly held by 2+ conversations.
 *
 * On top: a global sliding-window TURN cap. Signals past the cap still fold
 * into the `<attention>` block (visible next turn) -- they just don't buy an
 * LLM turn. Rate limiting spend, not awareness.
 */

export type AttentionSignal =
  | {
      kind: 'needs_you'
      conversationId: string
      project: string | null
      state: 'needs_you' | 'blocked'
      title?: string
    }
  | { kind: 'git_alert'; project: string; alert: string }
  | { kind: 'contended'; project: string; target: string; holders: number }

export interface AttentionPolicyOpts {
  needsYouCooldownMs?: number
  gitAlertCooldownMs?: number
  contendedCooldownMs?: number
  maxTurnsPerHour?: number
}

const DEFAULTS = {
  needsYouCooldownMs: 30 * 60_000,
  gitAlertCooldownMs: 6 * 60 * 60_000,
  contendedCooldownMs: 2 * 60 * 60_000,
  maxTurnsPerHour: 6,
}

const HOUR_MS = 60 * 60_000
const ATTENTION_STATES = new Set(['needs_you', 'blocked'])

export interface AttentionPolicy {
  /** A live-status report for a conversation. Returns a signal only on the
   *  TRANSITION into needs_you/blocked, at most once per cooldown per conv. */
  observeStatus(
    conversationId: string,
    project: string | null,
    state: string,
    ts: number,
    title?: string,
  ): AttentionSignal | null
  /** A git-fabric scan's escalation alerts for a project. New-per-cooldown only. */
  observeGitAlerts(project: string, alerts: string[], ts: number): AttentionSignal[]
  /** The current CONTENDED targets for a project. New-per-cooldown only. */
  observeContended(project: string, targets: Array<{ target: string; holders: number }>, ts: number): AttentionSignal[]
  /** Global turn budget: true = an LLM turn may run for this signal (consumes
   *  a slot); false = fold into the block silently. Sliding 1h window. */
  allowTurn(ts: number): boolean
}

export function createAttentionPolicy(opts: AttentionPolicyOpts = {}): AttentionPolicy {
  const cfg = { ...DEFAULTS, ...opts }
  const lastState = new Map<string, string>()
  const firedAt = new Map<string, number>() // dedupe key -> last fire ts
  let turnGrants: number[] = []

  function coolingDown(key: string, ts: number, cooldownMs: number): boolean {
    const prev = firedAt.get(key)
    if (prev !== undefined && ts - prev < cooldownMs) return true
    firedAt.set(key, ts)
    return false
  }

  return {
    observeStatus(conversationId, project, state, ts, title) {
      const prev = lastState.get(conversationId)
      lastState.set(conversationId, state)
      if (!ATTENTION_STATES.has(state)) return null
      if (prev !== undefined && ATTENTION_STATES.has(prev)) return null // no flip
      if (coolingDown(`status:${conversationId}`, ts, cfg.needsYouCooldownMs)) return null
      const sig: AttentionSignal = {
        kind: 'needs_you',
        conversationId,
        project,
        state: state as 'needs_you' | 'blocked',
      }
      if (title) sig.title = title
      return sig
    },

    observeGitAlerts(project, alerts, ts) {
      const out: AttentionSignal[] = []
      for (const alert of alerts) {
        if (coolingDown(`git:${project}:${alert}`, ts, cfg.gitAlertCooldownMs)) continue
        out.push({ kind: 'git_alert', project, alert })
      }
      return out
    },

    observeContended(project, targets, ts) {
      const out: AttentionSignal[] = []
      for (const t of targets) {
        if (coolingDown(`contended:${project}:${t.target}`, ts, cfg.contendedCooldownMs)) continue
        out.push({ kind: 'contended', project, target: t.target, holders: t.holders })
      }
      return out
    },

    allowTurn(ts) {
      turnGrants = turnGrants.filter(t => ts - t < HOUR_MS)
      if (turnGrants.length >= cfg.maxTurnsPerHour) return false
      turnGrants.push(ts)
      return true
    },
  }
}

/** One human line per signal -- what lands in the `<attention>` block and the
 *  impulse trigger prompt. */
export function describeSignal(sig: AttentionSignal): string {
  switch (sig.kind) {
    case 'needs_you': {
      const who = sig.title ? `"${sig.title}"` : sig.conversationId.slice(0, 8)
      const where = sig.project ? ` in ${sig.project}` : ''
      return `conversation ${who}${where} flipped to ${sig.state}`
    }
    case 'git_alert':
      return `git escalation "${sig.alert}" on ${sig.project}`
    case 'contended':
      return `CONTENDED: ${sig.holders} conversations on "${sig.target}" in ${sig.project}`
  }
}
