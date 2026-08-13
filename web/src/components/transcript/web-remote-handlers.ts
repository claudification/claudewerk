/**
 * Registry for the remote-control (`web_*`) tool renderers. One flat map the
 * dispatcher spreads into its handler table, keyed by the legacy
 * `mcp__rclaude__*` name (the dispatcher tries the claudewerk/claudwerk brand
 * aliases against the same keys).
 */

import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'
import {
  renderWebExecuteCommand,
  renderWebListClients,
  renderWebListCommands,
  renderWebReadTranscript,
  renderWebSendPrompt,
  renderWebSetConversation,
} from './tool-cases-web-drive'
import {
  renderWebExecuteScript,
  renderWebPerfReport,
  renderWebScreenshot,
  renderWebSetPerfMonitor,
} from './tool-cases-web-script'
import {
  renderWebTerminalAttach,
  renderWebTerminalList,
  renderWebTerminalRead,
  renderWebTerminalScreenshot,
  renderWebTerminalStart,
  renderWebTerminalWrite,
} from './tool-cases-web-terminal'

export const WEB_REMOTE_HANDLERS: Record<string, (ctx: ToolCaseInput) => ToolCaseResult> = {
  mcp__rclaude__web_execute_script: renderWebExecuteScript,
  mcp__rclaude__web_screenshot: renderWebScreenshot,
  mcp__rclaude__web_set_perf_monitor: renderWebSetPerfMonitor,
  mcp__rclaude__web_perf_report: renderWebPerfReport,
  mcp__rclaude__web_list_clients: renderWebListClients,
  mcp__rclaude__web_list_commands: renderWebListCommands,
  mcp__rclaude__web_execute_command: renderWebExecuteCommand,
  mcp__rclaude__web_set_conversation: renderWebSetConversation,
  mcp__rclaude__web_send_prompt: renderWebSendPrompt,
  mcp__rclaude__web_read_transcript: renderWebReadTranscript,
  mcp__rclaude__web_terminal_list: renderWebTerminalList,
  mcp__rclaude__web_terminal_start: renderWebTerminalStart,
  mcp__rclaude__web_terminal_attach: ctx => renderWebTerminalAttach('attach', ctx),
  mcp__rclaude__web_terminal_detach: ctx => renderWebTerminalAttach('detach', ctx),
  mcp__rclaude__web_terminal_read: renderWebTerminalRead,
  mcp__rclaude__web_terminal_write: renderWebTerminalWrite,
  mcp__rclaude__web_terminal_screenshot: renderWebTerminalScreenshot,
}
