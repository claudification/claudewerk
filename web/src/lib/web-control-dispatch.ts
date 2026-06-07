/**
 * Web Debug Control -- request dispatcher (client side).
 *
 * Executes a broker-relayed `web_control_request` in THIS browser and replies
 * with `web_control_response`. Every op is gated on a live local grant first
 * (default-deny): if the user has not opted in (or the grant expired), the op
 * is refused regardless of what the broker sent. Each executed op raises a
 * visibility toast so the user always sees the browser being driven.
 */

import type { TranscriptContentBlock, TranscriptEntry, WebControlOp } from '@shared/protocol'
import { sendInput, useConversationsStore } from '@/hooks/use-conversations'
import { captureNodeToUrl } from './web-control-capture'
import { executeCommand, getCommands } from './commands'
import { getActiveWebControlGrant } from './web-control-grant'
import {
  terminalAttach,
  terminalDetach,
  terminalList,
  terminalRead,
  terminalScreenshot,
  terminalStart,
  type TermResult,
  terminalWrite,
} from './web-control-terminal'

type Send = (msg: Record<string, unknown>) => void

interface WebControlRequestMsg {
  requestId: string
  op: WebControlOp
  args?: Record<string, unknown>
}

const TRANSCRIPT_TEXT_CAP = 16_000

function respond(send: Send, requestId: string, ok: boolean, result?: unknown, error?: string): void {
  send({ type: 'web_control_response', requestId, ok, result, error })
}

/** Relay a terminal-op result (TermResult) back, with a visibility toast. */
function sendTerm(send: Send, requestId: string, op: WebControlOp, r: TermResult): void {
  const target = (r.result as { shellId?: string } | undefined)?.shellId
  toast(op, target ? target.slice(0, 12) : '')
  respond(send, requestId, r.ok, r.result, r.error)
}

function toast(op: WebControlOp, detail: string): void {
  window.dispatchEvent(
    new CustomEvent('rclaude-toast', {
      detail: {
        title: 'Agent remote-control',
        body: `${op}${detail ? `: ${detail}` : ''}`,
        variant: 'info',
      },
    }),
  )
}

/** Entry point wired into the WS onmessage bypass. */
export async function handleWebControlRequest(msg: WebControlRequestMsg, send: Send): Promise<void> {
  const { requestId, op } = msg
  const args = msg.args ?? {}

  // Default-deny: a live local grant is required for every op.
  if (!getActiveWebControlGrant()) {
    respond(send, requestId, false, undefined, 'Browser is not opted-in to remote control (no active grant).')
    return
  }

  try {
    switch (op) {
      case 'screenshot':
        await opScreenshot(send, requestId, args)
        break
      case 'list_commands':
        opListCommands(send, requestId)
        break
      case 'execute_command':
        opExecuteCommand(send, requestId, args)
        break
      case 'set_conversation':
        opSetConversation(send, requestId, args)
        break
      case 'read_transcript':
        opReadTranscript(send, requestId, args)
        break
      case 'send_prompt':
        opSendPrompt(send, requestId, args)
        break
      case 'terminal_list':
        sendTerm(send, requestId, op, terminalList())
        break
      case 'terminal_start':
        sendTerm(send, requestId, op, await terminalStart(args))
        break
      case 'terminal_attach':
        sendTerm(send, requestId, op, await terminalAttach(args))
        break
      case 'terminal_detach':
        sendTerm(send, requestId, op, terminalDetach(args))
        break
      case 'terminal_read':
        sendTerm(send, requestId, op, terminalRead(args))
        break
      case 'terminal_write':
        sendTerm(send, requestId, op, terminalWrite(args))
        break
      case 'terminal_screenshot':
        sendTerm(send, requestId, op, await terminalScreenshot(args))
        break
      default:
        respond(send, requestId, false, undefined, `Unknown op '${op}'`)
    }
  } catch (e) {
    respond(send, requestId, false, undefined, e instanceof Error ? e.message : String(e))
  }
}

async function opScreenshot(send: Send, requestId: string, args: Record<string, unknown>): Promise<void> {
  const selector = typeof args.selector === 'string' ? args.selector : undefined
  const el = selector ? document.querySelector<HTMLElement>(selector) : document.body
  if (!el) {
    respond(send, requestId, false, undefined, `No element matched selector '${selector}'`)
    return
  }
  toast('screenshot', selector ?? 'viewport')
  const { url, error } = await captureNodeToUrl(el, selector ? 2 : 1)
  if (!url) {
    respond(send, requestId, false, undefined, error ?? 'screenshot failed')
    return
  }
  respond(send, requestId, true, { url })
}

function opListCommands(send: Send, requestId: string): void {
  toast('list_commands', '')
  const commands = getCommands().map(c => ({ id: c.id, label: c.label, group: c.group, shortcut: c.shortcut }))
  respond(send, requestId, true, commands)
}

function opExecuteCommand(send: Send, requestId: string, args: Record<string, unknown>): void {
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

function opSetConversation(send: Send, requestId: string, args: Record<string, unknown>): void {
  const conversationId = typeof args.conversationId === 'string' ? args.conversationId : ''
  if (!conversationId) {
    respond(send, requestId, false, undefined, 'set_conversation requires conversationId')
    return
  }
  toast('set_conversation', conversationId.slice(0, 8))
  useConversationsStore.getState().selectConversation(conversationId, 'remote-control')
  respond(send, requestId, true, { selected: conversationId })
}

function opReadTranscript(send: Send, requestId: string, args: Record<string, unknown>): void {
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
  respond(send, requestId, true, {
    conversationId,
    count: entries.length,
    text: serializeTranscript(entries),
  })
}

function opSendPrompt(send: Send, requestId: string, args: Record<string, unknown>): void {
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

// ── Transcript text serialization (bounded) ──────────────────────────────

function blocksToText(content: string | TranscriptContentBlock[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    const b = block as TranscriptContentBlock & Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'thinking') parts.push('[thinking]')
    else if (b.type === 'tool_use') parts.push(`[tool_use: ${String(b.name ?? '')}]`)
    else if (b.type === 'tool_result') parts.push('[tool_result]')
    else parts.push(`[${String(b.type)}]`)
  }
  return parts.join('\n')
}

function serializeTranscript(entries: TranscriptEntry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    const e = entry as TranscriptEntry & Record<string, unknown>
    let line: string
    switch (e.type) {
      case 'user':
        line = `USER: ${blocksToText((e.message as { content?: string | TranscriptContentBlock[] })?.content)}`
        break
      case 'assistant':
        line = `ASSISTANT: ${blocksToText((e.message as { content?: string | TranscriptContentBlock[] })?.content)}`
        break
      case 'system':
        line = `SYSTEM${e.subtype ? `(${String(e.subtype)})` : ''}: ${String(e.content ?? '')}`
        break
      default:
        line = `[${String(e.type)}${e.step ? ` ${String(e.step)}` : ''}${e.detail ? `: ${String(e.detail)}` : ''}]`
    }
    lines.push(line.trim())
  }
  let out = lines.filter(Boolean).join('\n\n')
  if (out.length > TRANSCRIPT_TEXT_CAP) {
    out = `${out.slice(-TRANSCRIPT_TEXT_CAP)}\n\n[...truncated to last ${TRANSCRIPT_TEXT_CAP} chars]`
  }
  return out
}
