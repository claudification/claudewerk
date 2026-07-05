/**
 * Shared plumbing for the QUEST MCP verb family (quest.ts + quest-verbs-*.ts).
 * A LEAF module (imports only ./types) so the registrar and the verb files can
 * both depend on it without a cycle.
 */

import type { ToolDef, ToolResult } from './types'

/** Posts one op-envelope to the broker `/api/quest` route; wired in quest.ts. */
export type QuestPost = (body: Record<string, unknown>) => Promise<ToolResult>

/** A verb whose only inputs are project + petname (get/status/pause). Extracted
 *  so these three don't repeat the identical schema + guard (no-duplication). */
export function petnameVerb(op: string, description: string, post: QuestPost): ToolDef {
  return {
    description,
    inputSchema: {
      type: 'object' as const,
      properties: { project: PROJECT_PROP, petname: { type: 'string', description: 'The quest petname (required).' } },
      required: ['project', 'petname'],
    },
    async handle(p: Record<string, string>) {
      if (!p.project || !p.petname) return questErr('project + petname are required')
      return post({ project: p.project, op, petname: p.petname })
    },
  }
}

export const PROJECT_PROP = { type: 'string', description: 'Canonical project URI the quest belongs to (required).' }

export function questErr(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true }
}

/** Parse a JSON param, returning `{ error }` on malformed input. */
export function parseJson<T>(raw: string | undefined, label: string): T | undefined | { error: string } {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return { error: `${label} must be valid JSON` }
  }
}
