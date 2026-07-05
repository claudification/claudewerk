/**
 * Handler registry barrel: registers all WS message handlers.
 * Call registerAllHandlers() once at startup before accepting connections.
 */

import { registerBootLifecycleHandlers } from './boot-lifecycle'
import { registerCanvasSyncHandlers } from './canvas-sync'
import { registerChannelHandlers } from './channel'
import { registerChecklistHandlers } from './checklist'
import { registerDashboardActionHandlers } from './control-panel-actions'
import { registerConversationLifecycleHandlers } from './conversation-lifecycle'
import { registerConversationReassignHandlers } from './conversation-reassign'
import { registerDaemonHandlers } from './daemon'
import { registerDebugControlHandlers } from './debug-control'
import { registerDialogHandlers } from './dialog'
import { registerDialogLiveHandlers } from './dialog-live'
import { registerDispatchHandlers } from './dispatch-actions'
import { registerGatewayHandlers } from './gateway'
import { registerInterConversationHandlers } from './inter-conversation'
import { registerJsonStreamHandlers } from './json-stream'
import { registerNightshiftHandlers } from './nightshift'
import { registerNightshiftWatchdogHandlers } from './nightshift-watchdog'
import { registerPermissionHandlers } from './permissions'
import { registerPlanApprovalHandlers } from './plan-approval'
import { registerProjectHandlers } from './project'
import { registerQuestHandlers } from './quest'
import { registerRclaudeConfigHandlers } from './rclaude-config'
import { registerRecapHandlers } from './recap'
import { registerSentinelHandlers } from './sentinel'
import { registerShellHandlers } from './shell'
import { registerSotuHandlers } from './sotu'
import { registerSotuConfigHandlers } from './sotu-config'
import { registerSotuDashboardHandlers } from './sotu-dashboard'
import { registerSotuMcpHandlers } from './sotu-mcp'
import { registerSpawnHandlers } from './spawn'
import { registerSpawnApprovalHandlers } from './spawn-approval'
import { registerStatusHandlers } from './status'
import { registerTerminalHandlers } from './terminal'
import { registerThinkingProgressHandlers } from './thinking-progress'
import { registerTranscriptHandlers } from './transcript'
import { registerVoiceHandlers } from './voice'
import { registerWebControlHandlers } from './web-control'

export function registerAllHandlers(): void {
  registerDebugControlHandlers()
  registerSentinelHandlers()
  registerBootLifecycleHandlers()
  registerCanvasSyncHandlers()
  registerChannelHandlers()
  registerChecklistHandlers()
  registerDashboardActionHandlers()
  registerDispatchHandlers()
  registerDialogHandlers()
  registerDialogLiveHandlers()
  registerGatewayHandlers()
  registerInterConversationHandlers()
  registerJsonStreamHandlers()
  registerPermissionHandlers()
  registerPlanApprovalHandlers()
  registerProjectHandlers()
  registerNightshiftHandlers()
  registerNightshiftWatchdogHandlers()
  registerQuestHandlers()
  registerRclaudeConfigHandlers()
  registerRecapHandlers()
  registerConversationLifecycleHandlers()
  registerConversationReassignHandlers()
  registerDaemonHandlers()
  registerSotuHandlers()
  registerSotuMcpHandlers()
  registerSotuConfigHandlers()
  registerSotuDashboardHandlers()
  registerSpawnApprovalHandlers()
  registerStatusHandlers()
  registerSpawnHandlers()
  registerShellHandlers()
  registerTerminalHandlers()
  registerThinkingProgressHandlers()
  registerTranscriptHandlers()
  registerVoiceHandlers()
  registerWebControlHandlers()
}
