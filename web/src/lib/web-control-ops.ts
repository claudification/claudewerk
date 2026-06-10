/**
 * Web Debug Control -- per-op handlers (client side).
 *
 * Each op executes one broker-relayed `web_control_request` in THIS browser and
 * replies via `respond`. Every op raises a visibility toast (the dispatcher also
 * logs every op to the debug log). The dispatcher (web-control-dispatch.ts) owns
 * the grant gate + routing; these are the bodies.
 */

import { sendInput, useConversationsStore } from '@/hooks/use-conversations'
import { executeCommand, getCommands } from './commands'
import { isPerfEnabled } from './perf-metrics'
import { buildPerfReport } from './perf-report'
import { captureNodeToUrl } from './web-control-capture'
import { isScriptEnabled } from './web-control-grant'
import { respond, type Send, toast } from './web-control-reply'
import { captureScreenToUrl, hasScreenShare, isScreenShareSupported } from './web-control-screen-capture'
import { runScript } from './web-control-script'
import { serializeTranscript } from './web-control-transcript'

export { respond, type Send, sendTerm } from './web-control-reply'

async function captureForScreenshot(
  selector: string | undefined,
  el: HTMLElement | null,
): Promise<{ url?: string; error?: string }> {
  // Preferred: getDisplayMedia (freeze-free, real pixels). Needs the user to have
  // armed Share-screen (a gesture the agent can't make).
  if (isScreenShareSupported()) {
    if (!hasScreenShare()) {
      return {
        error: 'Screen sharing is not armed. Ask the user to click "Share screen" in Settings > System > Debug.',
      }
    }
    return captureScreenToUrl(el)
  }
  // Fallback (Safari standalone PWA: no getDisplayMedia): DOM rasterizer. No
  // cacheBust, so it no longer hangs. Whole-app captures can still be heavy.
  return captureNodeToUrl(el ?? document.body, selector ? 2 : 1)
}

export async function opScreenshot(send: Send, requestId: string, args: Record<string, unknown>): Promise<void> {
  const selector = typeof args.selector === 'string' ? args.selector : undefined
  let el: HTMLElement | null = null
  if (selector) {
    el = document.querySelector<HTMLElement>(selector)
    if (!el) {
      respond(send, requestId, false, undefined, `No element matched selector '${selector}'`)
      return
    }
  }
  toast('screenshot', selector ?? 'viewport')
  const { url, error } = await captureForScreenshot(selector, el)
  if (!url) {
    respond(send, requestId, false, undefined, error ?? 'screenshot failed')
    return
  }
  respond(send, requestId, true, { url })
}

export function opListCommands(send: Send, requestId: string): void {
  toast('list_commands', '')
  const commands = getCommands().map(c => ({ id: c.id, label: c.label, group: c.group, shortcut: c.shortcut }))
  respond(send, requestId, true, commands)
}

export function opExecuteCommand(send: Send, requestId: string, args: Record<string, unknown>): void {
  const id = typeof args.id === 'string' ? args.id : ''
  const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : []
  if (!id) {
    respond(send, requestId, false, undefined, 'execute_command requires an id')
    return
  }
  toast('execute_command', id)
  const executed = executeCommand(id, ...cmdArgs)
  if (!executed) {
    respond(send, requestId, false, undefined, `Command '${id}' not found or not currently available`)
    return
  }
  respond(send, requestId, true, { executed: true, id })
}

export function opSetConversation(send: Send, requestId: string, args: Record<string, unknown>): void {
  const conversationId = typeof args.conversationId === 'string' ? args.conversationId : ''
  if (!conversationId) {
    respond(send, requestId, false, undefined, 'set_conversation requires conversationId')
    return
  }
  toast('set_conversation', conversationId.slice(0, 8))
  useConversationsStore.getState().selectConversation(conversationId, 'remote-control')
  respond(send, requestId, true, { selected: conversationId })
}

export function opReadTranscript(send: Send, requestId: string, args: Record<string, unknown>): void {
  const store = useConversationsStore.getState()
  const conversationId = typeof args.conversationId === 'string' ? args.conversationId : store.selectedConversationId
  const format = args.format === 'json' ? 'json' : 'text'
  if (!conversationId) {
    respond(send, requestId, false, undefined, 'No conversation is active and none was specified')
    return
  }
  const entries = store.transcripts[conversationId]
  if (!entries) {
    respond(
      send,
      requestId,
      false,
      undefined,
      `Conversation '${conversationId.slice(0, 8)}' is not loaded in this browser (open it first or pass a loaded one)`,
    )
    return
  }
  toast('read_transcript', conversationId.slice(0, 8))
  if (format === 'json') {
    respond(send, requestId, true, { conversationId, count: entries.length, entries })
    return
  }
  respond(send, requestId, true, { conversationId, count: entries.length, text: serializeTranscript(entries) })
}

export function opSendPrompt(send: Send, requestId: string, args: Record<string, unknown>): void {
  const conversationId = typeof args.conversationId === 'string' ? args.conversationId : ''
  const text = typeof args.text === 'string' ? args.text : ''
  if (!conversationId || !text) {
    respond(send, requestId, false, undefined, 'send_prompt requires conversationId and text')
    return
  }
  toast('send_prompt', `${conversationId.slice(0, 8)}: ${text.slice(0, 40)}`)
  const ok = sendInput(conversationId, text)
  respond(send, requestId, ok, { sent: ok, conversationId }, ok ? undefined : 'Send failed (socket not open?)')
}

export function opPerfReport(send: Send, requestId: string, args: Record<string, unknown>): void {
  if (!isPerfEnabled()) {
    respond(
      send,
      requestId,
      false,
      undefined,
      'Perf monitor is OFF, so no samples are being recorded. Turn it on with set_perf_monitor {enabled:true}, reproduce the activity, then grab the report.',
    )
    return
  }
  const significantOnly = args.significantOnly === true
  toast('perf_report', significantOnly ? 'significant only' : 'full')
  respond(send, requestId, true, { report: buildPerfReport({ significantOnly }) })
}

export function opSetPerfMonitor(send: Send, requestId: string, args: Record<string, unknown>): void {
  if (typeof args.enabled !== 'boolean') {
    respond(send, requestId, false, undefined, 'set_perf_monitor requires { enabled: boolean }')
    return
  }
  toast('set_perf_monitor', args.enabled ? 'ON' : 'OFF')
  // Mirror the Settings toggle: updateControlPanelPrefs persists the pref AND
  // calls setPerfEnabled() to start/stop the ring buffer.
  useConversationsStore.getState().updateControlPanelPrefs({ showPerfMonitor: args.enabled })
  respond(send, requestId, true, { showPerfMonitor: args.enabled })
}

export async function opExecuteScript(send: Send, requestId: string, args: Record<string, unknown>): Promise<void> {
  // Default-deny the SEPARATE script sub-consent (on top of the base grant).
  if (!isScriptEnabled()) {
    respond(
      send,
      requestId,
      false,
      undefined,
      'Script execution is not enabled in this browser. The user must tick "Allow script execution" in Settings > System > Debug.',
    )
    return
  }
  const code = typeof args.code === 'string' ? args.code : ''
  if (!code) {
    respond(send, requestId, false, undefined, 'execute_script requires { code }')
    return
  }
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 20_000
  toast('execute_script', `${code.length} chars`)
  const { result, error } = await runScript(code, timeoutMs)
  if (error) {
    respond(send, requestId, false, undefined, error)
    return
  }
  respond(send, requestId, true, { result })
}
