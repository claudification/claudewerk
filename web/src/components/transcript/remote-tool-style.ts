/**
 * Icon + label for the remote-control (`web_*`) MCP family.
 *
 * They are all "the agent is driving a real browser / host shell", so they get
 * their own colour and icon instead of the generic teal MCP plug, and a short
 * label (`web/script`, `term/read`) instead of the truncated raw tool name.
 * Kept out of shared.tsx so that file does not grow further.
 */

import { type LucideIcon, MonitorCog, SquareTerminal } from 'lucide-react'

const REMOTE_TOOL_RE = /^mcp__(?:rclaude|claudewerk|claudwerk)__web_/

const REMOTE_STYLE = { color: 'text-fuchsia-400', Icon: MonitorCog as LucideIcon }
const REMOTE_TERMINAL_STYLE = { color: 'text-fuchsia-400', Icon: SquareTerminal as LucideIcon }

export function remoteToolStyle(name: string): { color: string; Icon: LucideIcon } | null {
  if (!REMOTE_TOOL_RE.test(name)) return null
  return name.includes('__web_terminal_') ? REMOTE_TERMINAL_STYLE : REMOTE_STYLE
}

const REMOTE_LABELS: Record<string, string> = {
  web_execute_script: 'web/script',
  web_screenshot: 'web/shot',
  web_list_clients: 'web/clients',
  web_list_commands: 'web/commands',
  web_execute_command: 'web/run',
  web_set_conversation: 'web/goto',
  web_read_transcript: 'web/read',
  web_send_prompt: 'web/prompt',
  web_perf_report: 'web/perf',
  web_set_perf_monitor: 'web/perf',
  web_terminal_list: 'term/list',
  web_terminal_start: 'term/start',
  web_terminal_attach: 'term/attach',
  web_terminal_detach: 'term/detach',
  web_terminal_read: 'term/read',
  web_terminal_write: 'term/write',
  web_terminal_screenshot: 'term/shot',
}

/** Header label for a tool row. MCP tools drop the `mcp__server__` prefix; the
 *  remote-control family gets a hand-picked short label. */
export function shortToolLabel(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const parts = name.split('__')
  const tool = parts.slice(2).join('__')
  return REMOTE_LABELS[tool] || parts.slice(2).join('/') || parts[1] || name
}
