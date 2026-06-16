/**
 * Handler registry barrel: registers all WS message handlers.
 * Call registerAllHandlers() once at startup before accepting connections.
 */

import { registerBootLifecycleHandlers } from './boot-lifecycle'
import { registerChannelHandlers } from './channel'
import { registerChecklistHandlers } from './checklist'
import { registerDashboardActionHandlers } from './control-panel-actions'
import { registerConversationLifecycleHandlers } from './conversation-lifecycle'
import { registerConversationReassignHandlers } from './conversation-reassign'
import { registerDaemonHandlers } from './daemon'
import { registerDebugControlHandlers } from './debug-control'
import { registerDialogHandlers } from './dialog'
import { registerGatewayHandlers } from './gateway'
import { registerInterConversationHandlers } from './inter-conversation'
import { registerJsonStreamHandlers } from './json-stream'
import { registerPermissionHandlers } from './permissions'
import { registerPlanApprovalHandlers } from './plan-approval'
import { registerProjectHandlers } from './project'
import { registerRclaudeConfigHandlers } from './rclaude-config'
import { registerRecapHandlers } from './recap'
import { registerSentinelHandlers } from './sentinel'
import { registerShellHandlers } from './shell'
import { registerSpawnHandlers } from './spawn'
import { registerSpawnApprovalHandlers } from './spawn-approval'
import { registerTerminalHandlers } from './terminal'
import { registerThinkingProgressHandlers } from './thinking-progress'
import { registerTranscriptHandlers } from './transcript'
import { registerVoiceHandlers } from './voice'
import { registerWebControlHandlers } from './web-control'

export function registerAllHandlers(): void {
  registerDebugControlHandlers()
  registerSentinelHandlers()
  registerBootLifecycleHandlers()
  registerChannelHandlers()
  registerChecklistHandlers()
  registerDashboardActionHandlers()
  registerDialogHandlers()
  registerGatewayHandlers()
  registerInterConversationHandlers()
  registerJsonStreamHandlers()
  registerPermissionHandlers()
  registerPlanApprovalHandlers()
  registerProjectHandlers()
  registerRclaudeConfigHandlers()
  registerRecapHandlers()
  registerConversationLifecycleHandlers()
  registerConversationReassignHandlers()
  registerDaemonHandlers()
  registerSpawnApprovalHandlers()
  registerSpawnHandlers()
  registerShellHandlers()
  registerTerminalHandlers()
  registerThinkingProgressHandlers()
  registerTranscriptHandlers()
  registerVoiceHandlers()
  registerWebControlHandlers()
}
