import type { LiveStatusInput, LiveStatusState } from '../../../shared/protocol'
import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

const STATES: readonly LiveStatusState[] = ['working', 'done', 'needs_you', 'blocked']

/**
 * The `set_status` tool description is the PRIMARY instruction surface — it's how
 * the agent learns to use the fields SPARINGLY. The decision tests below are
 * deliberately blunt so the agent self-selects one field instead of dumping
 * everything. Keep them sharp if you edit this.
 */
const DESCRIPTION = `Report what THIS conversation is doing, so the user can triage many conversations at a glance. The control panel shows ONE badge per conversation keyed off \`state\`; the text fields are detail shown on expand. Call this when your state meaningfully changes (you start real work, you finish, you get stuck, you need the user) — not on every message.

USE YOUR JUDGMENT — this is a subjective call. A small step, a quick lookup, a one-off command, or routine back-and-forth that does NOT change how the user would triage this conversation does NOT need a status; skip it. Reserve the call for moments that actually move the triage signal: you finished (\`done\`), you're blocked on the user (\`needs_you\`), you're stuck (\`blocked\`), or you genuinely want to surface progress detail mid-work (\`working\`). When in doubt, fewer is better — an over-reported conversation is noise.

\`state\` (REQUIRED) is the one signal that matters:
- \`working\`  — actively doing the task. (This is also the default at the start of every turn; you don't need to set it just to confirm you're working, but do set it if you want to show progress detail.)
- \`done\`     — the task the user asked for is COMPLETE. Nothing remains that blocks completion.
- \`needs_you\` — you are blocked ON THE USER for something only THEY can supply: a decision, an answer, an approval. Prefer opening a real dialog / AskUserQuestion / ExitPlanMode for this — that's what escalates to the user's phone. A bare \`needs_you\` shows the badge but does not buzz them.
- \`blocked\`  — you are stuck on something NOT the user's to fix (a failing build, a missing credential, a dead end) and cannot proceed.

A PENDING DEPLOY IS NOT \`needs_you\`. "Needs a broker restart", "run \`build:packages\`", "restart the sentinel", "hard refresh / \`Clear cache & reload\`" — the code is written, merged and correct; only an operational step the user runs on their own cadence is left. That belongs in \`notes\` with \`state:'done'\`, NEVER in \`needs_you\` or \`pending\`. Test: if the user restarted the thing tonight without saying a word to you, would the task be complete? If yes, it is a NOTE. Parking a finished task under \`needs_you\` makes the badge mean "I am waiting" when nobody is actually blocked, and the conversation rots. Reserve \`needs_you\` for a real question with no default answer.

The text fields are ALL OPTIONAL and render as MARKDOWN in the control panel (the \`done\`/\`pending\`/etc. values support **bold**, \`code\`, links, and \`- \` bullet lists — use them when they make the handoff clearer, but keep it tight). Empty is signal: a fully-finished task is \`state:'done'\` with one line in \`done\` and everything else empty. NEVER manufacture content to fill them.
- \`done\`    — what you FINISHED.
- \`pending\` — what still MUST happen for this to be complete. Test: "does this BLOCK done?" If no, it is NOT pending — it's a note.
- \`caveats\` — it works, but watch X.
- \`blocked\` — what you tried and could NOT finish, and why (the error / dead-end). Not "things I chose not to do."
- \`notes\`   — FYI asides that are NOT todos. Test: "is this still true even though the task IS complete?" e.g. "didn't commit", "left the dev server running", and EVERY un-run deploy step — "broker restart pending", "needs \`build:packages\`", "sentinel restart pending", "hard refresh to pick up the bundle" → ALWAYS a note, never pending, blocked, or \`needs_you\`. Don't nag the user with routine hygiene.
- \`safe_to_close\` (boolean) — set true ONLY when this conversation is genuinely disposable: no uncommitted/unpushed work, no pending interaction, nothing the user still needs from it. It surfaces as a visible marker so the user can spot which conversations they can just close. When unsure, leave it off.
- \`notify\` (plain text) — USE SPARINGLY. A short one-line message that physically BUZZES the user's phone and browser right now (a real push, same as the \`notify\` tool). Set this ONLY when you genuinely need to grab their attention away from whatever they're doing — never for routine status. The badge \`state\` is the quiet signal; \`notify\` is the loud one. Most set_status calls MUST omit it. Plain text, not markdown.

THIS CALL IS THE HANDOFF. When you set \`done\`, the control panel renders it as the conversation's final, user-visible result — you do NOT need to call set_status again, and a separate written summary afterward is redundant noise. Put the substance IN the fields (they're markdown) and let the card speak. At most a single short sign-off line; never re-explain what the card already shows.`

const INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    state: {
      type: 'string',
      enum: STATES,
      description: 'Required triage signal: working | done | needs_you | blocked',
    },
    done: { type: 'string', description: 'What FINISHED (markdown)' },
    pending: { type: 'string', description: 'What still must happen to be COMPLETE, blocks "done" (markdown)' },
    caveats: { type: 'string', description: 'Done-but-watch (markdown)' },
    blocked: { type: 'string', description: 'What did NOT get done + why, error / dead-end (markdown)' },
    notes: { type: 'string', description: 'FYI asides that are NOT todos, e.g. "did not commit" (markdown)' },
    safe_to_close: {
      type: 'boolean',
      description: 'True only when the conversation is disposable: no uncommitted work, nothing pending',
    },
    notify: {
      type: 'string',
      description:
        "USE SPARINGLY — short plain-text line that physically buzzes the user's phone/browser (a real push). Only to grab attention, never for routine status.",
    },
  },
  required: ['state'],
}

/** Collect the non-empty status fields — "empty is signal". */
function buildStatus(params: Record<string, unknown>, state: LiveStatusState): LiveStatusInput {
  const status: LiveStatusInput = { state }
  for (const key of ['done', 'pending', 'caveats', 'blocked', 'notes'] as const) {
    const v = (params[key] as string | undefined)?.trim()
    if (v) status[key] = v
  }
  // safe_to_close arrives as a real boolean (or "true" string via some clients).
  const safe = params.safe_to_close
  if (safe === true || safe === 'true') status.safe_to_close = true
  return status
}

/** Reinforce that this call IS the handoff — no re-report or redundant summary after. */
function resultTail(state: LiveStatusState, buzzed: boolean): string {
  const tail =
    state === 'done'
      ? " — this is the conversation's handoff and renders as the user-visible result. No further set_status or summary needed."
      : state === 'working'
        ? '.'
        : ' — no further set_status needed this turn unless your state changes.'
  return `${tail}${buzzed ? ' Push sent to the user.' : ''}`
}

const errorResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

export function registerStatusTool(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    set_status: {
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      async handle(params) {
        const state = params.state as LiveStatusState
        if (!STATES.includes(state)) return errorResult(`Error: state must be one of ${STATES.join(', ')}`)
        if (!ctx.callbacks.onSetStatus) return errorResult('set_status is not available in this conversation.')

        ctx.callbacks.onSetStatus(buildStatus(params, state))
        debug(`[channel] set_status: ${state}`)

        // Optional attention-grab: a `notify` line shortcuts the `notify` tool,
        // firing a real push (phone/browser) via the same callback. The badge
        // `state` is the quiet signal; this is the loud one. Reuses the notify
        // wire+broker path wholesale.
        const buzz = (params.notify as string | undefined)?.trim()
        const buzzed = Boolean(buzz && ctx.callbacks.onNotify)
        if (buzz && ctx.callbacks.onNotify) {
          ctx.callbacks.onNotify(buzz)
          debug(`[channel] set_status notify: ${buzz.slice(0, 80)}`)
        }

        return { content: [{ type: 'text', text: `Status recorded: ${state}${resultTail(state, buzzed)}` }] }
      },
    },
  }
}
