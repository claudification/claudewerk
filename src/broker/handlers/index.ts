/**
 * Handler registry barrel: registers all WS message handlers.
 * Call registerAllHandlers() once at startup before accepting connections.
 */

import { registerBootLifecycleHandlers } from './boot-lifecycle'
import { registerChannelHandlers } from './channel'
import { registerDashboardActionHandlers } from './control-panel-actions'
import { registerConversationLifecycleHandlers } from './conversation-lifecycle'
import { registerConversationReassignHandlers } from './conversation-reassign'
import { registerDaemonHandlers } from './daemon'
import { registerDialogHandlers } from './dialog'
import { registerFileHandlers } from './files'
import { registerGatewayHandlers } from './gateway'
import { registerInterConversationHandlers } from './inter-conversation'
import { registerJsonStreamHandlers } from './json-stream'
import { registerPermissionHandlers } from './permissions'
import { registerPlanApprovalHandlers } from './plan-approval'
import { registerRclaudeConfigHandlers } from './rclaude-config'
import { registerRecapHandlers } from './recap'
import { registerSentinelHandlers } from './sentinel'
import { registerSpawnHandlers } from './spawn'
import { registerActivityPhraseHandlers } from './activity-phrase'
import { registerDebugControlHandlers } from './debug-control'
import { registerSpawnApprovalHandlers } from './spawn-approval'
import { registerTerminalHandlers } from './terminal'
import { registerThinkingProgressHandlers } from './thinking-progress'
import { registerTranscriptHandlers } from './transcript'
import { registerVoiceHandlers } from './voice'

export function registerAllHandlers(): void {
  registerActivityPhraseHandlers()
  registerDebugControlHandlers()
  registerSentinelHandlers()
  registerBootLifecycleHandlers()
  registerChannelHandlers()
  registerDashboardActionHandlers()
  registerDialogHandlers()
  registerFileHandlers()
  registerGatewayHandlers()
  registerInterConversationHandlers()
  registerJsonStreamHandlers()
  registerPermissionHandlers()
  registerPlanApprovalHandlers()
  registerRclaudeConfigHandlers()
  registerRecapHandlers()
  registerConversationLifecycleHandlers()
  registerConversationReassignHandlers()
  registerDaemonHandlers()
  registerSpawnApprovalHandlers()
  registerSpawnHandlers()
  registerTerminalHandlers()
  registerThinkingProgressHandlers()
  registerTranscriptHandlers()
  registerVoiceHandlers()
}
