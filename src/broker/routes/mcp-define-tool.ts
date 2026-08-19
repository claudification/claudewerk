import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'

/**
 * Register an MCP tool. The ONE place this codebase talks to the SDK's tool
 * registration API.
 *
 * `mcp.tool(name, description, schema, cb)` is deprecated in the SDK, and its
 * overload resolution breaks outright under zod >= 4.4.3: every call site
 * reports `Argument of type 'string' is not assignable to parameter of type
 * 'ZodRawShapeCompat'`, because the description-carrying overload stops being
 * selectable. That is what pinned zod at 4.3.6 -- 28 type errors across two
 * files, none of them ours.
 *
 * `registerTool` is the supported replacement and takes the description in a
 * config object instead of as a positional argument, which removes the
 * ambiguity. Routing every call through here keeps the argument order the call
 * sites already use, and means the next time the SDK moves this API it is one
 * edit rather than twenty-eight.
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
