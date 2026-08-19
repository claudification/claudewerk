import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'

/**
 * Register an MCP tool. The ONE place this codebase talks to the SDK's tool
 * registration API.
 *
 * `mcp.tool(...)` is deprecated in the SDK; `registerTool` is the supported
 * replacement and takes the description in a config object rather than as a
 * positional argument. Routing every call through here keeps the argument
 * order the call sites already used, and means the next time the SDK moves
 * this API it is one edit rather than twenty-eight.
 *
 * ZOD IS STILL PINNED AT 4.3.6, AND THIS DOES NOT CHANGE THAT.
 *
 * The pin was recorded as "4.4.3 breaks the .tool() overloads", which is only
 * the symptom. Measured 2026-08-19: under zod 4.4.3 a plain `z.string()`
 * satisfies `z4.$ZodType` on its own, but NOT the SDK's
 * `AnySchema = z3.ZodTypeAny | z4.$ZodType` compat union -- it is rejected
 * against the v3 arm and the union never admits it. So every schema literal
 * fails, whichever registration API you call, and moving to `registerTool`
 * turned 28 errors into 84 rather than zero.
 *
 * That makes it an upstream incompatibility between zod 4.4.3 and the SDK's
 * zod-compat layer, not something a call-site change can fix. Re-test the pin
 * when the SDK ships a compat update; the probe is three lines
 * (`const x: AnySchema = z.string()`).
 */
export function defineTool<Args extends ZodRawShapeCompat>(
  mcp: McpServer,
  name: string,
  description: string,
  inputSchema: Args,
  cb: ToolCallback<Args>,
): RegisteredTool {
  return mcp.registerTool(name, { description, inputSchema }, cb)
}
