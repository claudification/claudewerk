/**
 * Derive OpenAI Realtime function-schemas from the local agent-core-shaped tool
 * set (plan-dispatcher-build.md §9.4c). This is the "one tool set, two drivers"
 * seam: the same zod `inputSchema` that the text agent loop validates becomes
 * the Realtime `tools[]` function-schema for the voice session.
 *
 * OpenAI Realtime STRICT mode rules (enforced here):
 *   - parameters.additionalProperties === false
 *   - `required` lists EVERY property (so optional fields must be nullable in
 *     the source zod, not .optional()).
 */

import { z } from 'zod'
import type { ToolDef, Toolset } from './tool-def'

export interface RealtimeTool {
  type: 'function'
  name: string
  description: string
  parameters: {
    type: 'object'
    strict: true
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: false
  }
}

/** The minimum a tool needs to derive a Realtime schema -- just its docs +
 *  input shape. Decoupled from `execute` so the voice session can derive
 *  function-schemas without binding the (deps-carrying) executors. */
export type ToolSchema = Pick<ToolDef, 'description' | 'inputSchema'>

/** Convert one tool def into an OpenAI Realtime strict function-schema. */
export function toRealtimeTool(name: string, def: ToolSchema): RealtimeTool {
  const json = z.toJSONSchema(def.inputSchema, { target: 'draft-2020-12' }) as {
    type?: string
    properties?: Record<string, unknown>
    required?: string[]
  }
  const properties = json.properties ?? {}
  const propNames = Object.keys(properties)
  // STRICT: every property must be required. Optional source fields should be
  // nullable (so they appear here); if any are missing from `required`, surface
  // it loudly rather than shipping a schema OpenAI will reject.
  const required = json.required ?? []
  const missing = propNames.filter(p => !required.includes(p))
  if (missing.length > 0) {
    throw new Error(
      `realtime tool '${name}': strict mode requires every property in 'required'; ` +
        `missing ${JSON.stringify(missing)} -- make those fields .nullable() not .optional().`,
    )
  }
  return {
    type: 'function',
    name,
    description: def.description,
    parameters: {
      type: 'object',
      strict: true,
      properties,
      required: propNames,
      additionalProperties: false,
    },
  }
}

/** Derive the full Realtime tool array from a tool set. */
export function toRealtimeTools(toolset: Toolset): RealtimeTool[] {
  return Object.entries(toolset).map(([name, def]) => toRealtimeTool(name, def))
}
