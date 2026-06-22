/**
 * Local mirror of protokol agent-core's tool model (plan-dispatcher-build.md
 * §9.4c). We adopt agent-core's SHAPE without importing the cross-repo package
 * yet -- so the dispatcher's tool set is "agent-core-shaped but not
 * agent-core-imported". When Jonas calls vendor-now, swapping this helper for
 * `import { defineTool } from '@protokol/agent-core'` + `buildHarness` is
 * mechanical, because the tools are already in its shape.
 *
 * Mirrors `@protokol/agent-core` `src/tool-def.ts` + `src/tool-context.ts`:
 *   defineTool({ description, inputSchema:<zod>, execute:(args, ctx)=>..., gate?, idempotent? })
 *
 * The SAME tool set drives two runtimes: a text agent loop (the future
 * agent-core harness) AND an OpenAI Realtime voice session (schemas derived via
 * realtime-schema.ts). One zod schema, two drivers, one `execute`.
 */

import type { z } from 'zod'

/** What the tool's execute receives besides its args. Carries cancellation +
 *  caller identity. (agent-core's ToolContext also carries journal/spawn sites;
 *  we keep the minimal subset the dispatcher needs.) */
export interface ToolContext {
  /** Cooperative cancellation -- abort long calls when the turn is cancelled. */
  signal?: AbortSignal
  identity?: {
    userId?: string
    conversationId?: string
  }
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  description: string
  inputSchema: S
  execute: (args: z.infer<S>, ctx: ToolContext) => unknown | Promise<unknown>
  /** Optional budget/admission gate (agent-core GateSpec; opaque here). */
  gate?: unknown
  /** True if re-running with the same args is safe (dedupe-able). */
  idempotent?: boolean
}

/** Identity helper -- preserves the zod generic so `args` is fully typed. */
export function defineTool<S extends z.ZodType>(spec: ToolDef<S>): ToolDef<S> {
  return spec
}

/** A named collection of tools (agent-core's `Toolset`). */
export type Toolset = Record<string, ToolDef>
