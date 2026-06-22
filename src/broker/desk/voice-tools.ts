/**
 * The Jarvis voice tool contract (plan-dispatcher-build.md §5 item 6 + §9.4c).
 *
 * DERIVED, not hand-written: the OpenAI Realtime function-schemas come from the
 * ONE dispatcher tool set (`dispatchToolSchemas` in tools.ts) via the zod->
 * Realtime conversion. So voice and the future agent-core text loop share a
 * single source -- "one tool set, two drivers". When the voice model emits a
 * function-call, the web client maps it to the same `execute` the text loop
 * would run (the bound `buildDispatchToolset`).
 */

import { toRealtimeTool } from './realtime-schema'
import { dispatchToolSchemas } from './tools'

/** The Realtime `tools[]` array, derived from the dispatcher tool set. */
export const voiceTools = Object.entries(dispatchToolSchemas).map(([name, schema]) => toRealtimeTool(name, schema))

/** Tool names the web client must handle in its `onFunctionCall`. */
export const voiceToolNames = voiceTools.map(t => t.name)
