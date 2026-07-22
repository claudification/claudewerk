/**
 * THE VOICE CONTRACT (plan-voice-orb.md §4 + §5) -- the exact tool set the
 * Jarvis realtime session may call, and the bound executors behind it.
 *
 * DERIVED, never re-declared: the contract is a PICK from the already-built desk
 * toolsets (`tools.ts` = the dispatch/threads set, `dispatch-tools.ts` = the wide
 * server set). One definition per tool means a description or schema edit
 * upstream can never drift from what the voice model is offered. The mint
 * (voice-mint.ts) derives the OpenAI Realtime function-schemas from the SAME
 * bound set that the `voice_tool_call` handler executes -- "one tool set, two
 * drivers", now with the drivers provably in sync.
 *
 * ABSENCE IS THE STRONGEST GATE: `terminate` / `interrupt` / `inject` /
 * `configure` / `spawn` / `revive` / `link` / `unlink` are NOT in this contract
 * at any phase. A misheard "kill it" cannot fire what was never offered.
 * `voice-tools.test.ts` asserts their absence on every phase list.
 */

import { z } from 'zod'
import { buildDispatchToolset as buildWideToolset } from './dispatch-tools'
import { type RealtimeTool, toRealtimeTools } from './realtime-schema'
import { buildDispatchRuntimeToolDeps, type DispatchRuntime } from './runtime'
import { defineTool, type Toolset } from './tool-def'
import { buildDispatchToolset as buildDeskToolset } from './tools'

/** P0 -- the READ set + the two client-local verbs. Nothing here mutates the
 *  fleet: worst case the model reads status aloud or moves the user's screen. */
export const VOICE_READ_TOOLS = [
  'projects_overview',
  'list_conversations',
  'read_events',
  'state_of_union',
  'search_transcripts',
  'control_screen',
  'reload_yourself',
] as const

/** P2 -- the ACTION verbs, gated behind the persona's spoken confirm + the cost
 *  gate (`confirm_expensive`). Added to the minted contract only at P2. */
export const VOICE_ACTION_TOOLS = [
  'dispatch',
  'conversation_select',
  'confirm_expensive',
  'dispatch_quest',
  'list_threads',
  'commit_thread',
] as const

/** Verbs that must NEVER reach the voice session, at any phase. Asserted. */
export const VOICE_FORBIDDEN_TOOLS = [
  'terminate',
  'interrupt',
  'inject',
  'configure',
  'spawn',
  'revive',
  'link',
  'unlink',
] as const

/**
 * What is minted TODAY (P2): the read set PLUS the action verbs.
 *
 * The actions are safe to offer because three independent gates stand behind
 * them, none of which the model can talk its way past:
 *   1. the persona's confirm ritual (voice-persona.ts -- say it, get a yes),
 *   2. the COST GATE: a `very_expensive` route comes back `awaitingConfirmation`
 *      and executes nothing until `confirm_expensive` (orchestrate.ts:126),
 *   3. the forbidden list is still absent -- nothing here can END a conversation.
 * The worst a misheard sentence can do is spawn a worker or route a message.
 */
export const ACTIVE_VOICE_TOOLS: readonly string[] = [...VOICE_READ_TOOLS, ...VOICE_ACTION_TOOLS]

/** Verbs the BROWSER answers itself -- the server executor is a stub that must
 *  never be reached (the tool-bridge intercepts them before the wire). Kept in
 *  the contract so the model is offered them and the schema lives in one place. */
const CLIENT_LOCAL_TOOLS: Toolset = {
  reload_yourself: defineTool({
    description:
      'Restart your own voice session -- use when the user says you are stuck, garbled, or asks you to reset yourself. Tear-down and re-greet is instant; the desk memory is server-side and survives.',
    inputSchema: z.object({}),
    execute: () => ({ clientLocal: 'reload_yourself is handled in the browser' }),
  }),
}

/** Every tool the voice contract may pick from, bound to the live broker.
 *
 *  `dispatch` here is the DETERMINISTIC path (`runDispatch` via
 *  buildDispatchRuntimeToolDeps), not the richer `runDispatchAgent` loop the
 *  text overlay uses. Deliberate for voice: one classifier hop is already a
 *  nested-LLM round trip inside a spoken turn, and the agent loop would need
 *  userId + tool-event streaming plumbed through this seam to stream its
 *  progress. Swapping it is a one-line deps change when that lands. */
function availableVoiceTools(rt: DispatchRuntime): Toolset {
  return {
    ...buildDeskToolset(buildDispatchRuntimeToolDeps(rt)),
    ...buildWideToolset(rt),
    ...CLIENT_LOCAL_TOOLS,
  }
}

/** The bound voice toolset: exactly `names`, in contract order. Throws on an
 *  unknown name so a typo in the contract fails loudly at mint, not mid-call. */
export function buildVoiceToolset(rt: DispatchRuntime, names: readonly string[] = ACTIVE_VOICE_TOOLS): Toolset {
  const available = availableVoiceTools(rt)
  const picked: Toolset = {}
  for (const name of names) {
    const tool = available[name]
    if (!tool) throw new Error(`voice contract: no tool named '${name}' in the desk toolsets`)
    picked[name] = tool
  }
  return picked
}

/** The Realtime `tools[]` array for the mint -- same source as the executors. */
export function voiceRealtimeTools(rt: DispatchRuntime, names?: readonly string[]): RealtimeTool[] {
  return toRealtimeTools(buildVoiceToolset(rt, names))
}
