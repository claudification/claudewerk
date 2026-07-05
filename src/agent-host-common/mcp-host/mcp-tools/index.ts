import { registerCanvasTools } from './canvas'
import { registerConversationTools } from './conversations'
import { registerDialogTool } from './dialog'
import { registerDialogControlTools } from './dialog-control'
import { registerDialogTaxonomyTool } from './dialog-taxonomy'
import { registerHostTools } from './hosts'
import { registerIdentityTools } from './identity'
import { registerNightshiftTools } from './nightshift'
import { registerNotifyTools } from './notify'
import { registerProjectBoardTools } from './project-board'
import { registerQuestTools } from './quest'
import { registerRecapTools } from './recap'
import { registerSearchTools } from './search'
import { registerSotuTools } from './sotu'
import { registerSpawnTools } from './spawn'
import { registerStatusTool } from './status'
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
    ...registerStatusTool(ctx),
    ...registerIdentityTools(ctx),
    ...registerConversationTools(ctx),
    ...registerSpawnTools(ctx),
    ...registerHostTools(ctx),
    ...registerProjectBoardTools(ctx),
    ...registerQuestTools(ctx),
    ...registerCanvasTools(ctx),
    ...registerNightshiftTools(ctx),
    ...registerDialogTool(ctx),
    ...registerDialogControlTools(ctx),
    ...registerDialogTaxonomyTool(),
    ...registerSearchTools(ctx),
    ...registerRecapTools(ctx),
    ...registerSotuTools(ctx),
    ...registerWebControlTools(ctx),
  }
}
