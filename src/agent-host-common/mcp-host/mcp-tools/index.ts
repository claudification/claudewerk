import { registerConversationTools } from './conversations'
import { registerDialogTool } from './dialog'
import { registerDialogControlTools } from './dialog-control'
import { registerHostTools } from './hosts'
import { registerIdentityTools } from './identity'
import { registerNightshiftTools } from './nightshift'
import { registerNotifyTools } from './notify'
import { registerProjectBoardTools } from './project-board'
import { registerRecapTools } from './recap'
import { registerSearchTools } from './search'
import { registerSpawnTools } from './spawn'
import type { McpToolContext, ToolDef } from './types'
import { registerWebControlTools } from './web-control'

export type {
  AgentHostIdentity,
  ConversationInfo,
  McpChannelCallbacks,
  McpToolContext,
  PendingDialog,
  ToolDef,
} from './types'

export function registerAllTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    ...registerNotifyTools(ctx),
    ...registerIdentityTools(ctx),
    ...registerConversationTools(ctx),
    ...registerSpawnTools(ctx),
    ...registerHostTools(ctx),
    ...registerProjectBoardTools(ctx),
    ...registerNightshiftTools(ctx),
    ...registerDialogTool(ctx),
    ...registerDialogControlTools(ctx),
    ...registerSearchTools(ctx),
    ...registerRecapTools(ctx),
    ...registerWebControlTools(ctx),
  }
}
