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

\`state\` (REQUIRED) is the one signal that matters:
- \`working\`  — actively doing the task. (This is also the default at the start of every turn; you don't need to set it just to confirm you're working, but do set it if you want to show progress detail.)
- \`done\`     — the task the user asked for is COMPLETE. Nothing remains that blocks completion.
- \`needs_you\` — you are blocked ON THE USER: a decision, an answer, an approval. Prefer opening a real dialog / AskUserQuestion / ExitPlanMode for this — that's what escalates to the user's phone. A bare \`needs_you\` shows the badge but does not buzz them.
- \`blocked\`  — you are stuck on something NOT the user's to fix (a failing build, a missing credential, a dead end) and cannot proceed.

The text fields are ALL OPTIONAL and render as MARKDOWN in the control panel (the \`done\`/\`pending\`/etc. values support **bold**, \`code\`, links, and \`- \` bullet lists — use them when they make the handoff clearer, but keep it tight). Empty is signal: a fully-finished task is \`state:'done'\` with one line in \`done\` and everything else empty. NEVER manufacture content to fill them.
- \`done\`    — what you FINISHED.
- \`pending\` — what still MUST happen for this to be complete. Test: "does this BLOCK done?" If no, it is NOT pending — it's a note.
- \`caveats\` — it works, but watch X.
- \`blocked\` — what you tried and could NOT finish, and why (the error / dead-end). Not "things I chose not to do."
- \`notes\`   — FYI asides that are NOT todos. Test: "is this still true even though the task IS complete?" e.g. "didn't commit", "didn't deploy", "left the dev server running" → ALWAYS a note, never pending or blocked. Don't nag the user with routine hygiene.
- \`safe_to_close\` (boolean) — set true ONLY when this conversation is genuinely disposable: no uncommitted/unpushed work, no pending interaction, nothing the user still needs from it. It surfaces as a visible marker so the user can spot which conversations they can just close. When unsure, leave it off.`

export function registerStatusTool(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    set_status: {
      description: DESCRIPTION,
      inputSchema: {
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
        },
        required: ['state'],
      },
      async handle(params) {
        const state = params.state as LiveStatusState
        if (!STATES.includes(state)) {
          return {
            content: [{ type: 'text', text: `Error: state must be one of ${STATES.join(', ')}` }],
            isError: true,
          }
        }
        // Only forward non-empty text fields — "empty is signal".
        const status: LiveStatusInput = { state }
        for (const key of ['done', 'pending', 'caveats', 'blocked', 'notes'] as const) {
          const v = params[key]?.trim()
          if (v) status[key] = v
        }
        // safe_to_close arrives as a real boolean (or "true" string via some clients).
        const safe = params.safe_to_close as unknown
        if (safe === true || safe === 'true') status.safe_to_close = true
        if (!ctx.callbacks.onSetStatus) {
          return {
            content: [{ type: 'text', text: 'set_status is not available in this conversation.' }],
            isError: true,
          }
        }
        ctx.callbacks.onSetStatus(status)
        debug(`[channel] set_status: ${state}`)
        return { content: [{ type: 'text', text: `Status set: ${state}` }] }
      },
    },
  }
}
