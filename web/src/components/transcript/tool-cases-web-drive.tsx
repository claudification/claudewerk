/**
 * Remote-control renderers -- the "drive the panel" ops: list clients/commands,
 * execute a palette command, navigate, send a prompt, read the transcript.
 */

import type { ReactNode } from 'react'
import { ConversationTag } from './conversation-tag'
import { TruncatedPre } from './shared'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'
import { Meta, payloadArray, payloadObject, RemoteSummary, RowList } from './web-remote-shared'

interface ClientRow {
  clientId?: string
  label?: string
  userName?: string
  ttlMs?: number
}

export function renderWebListClients(ctx: ToolCaseInput): ToolCaseResult {
  const clients = (payloadArray(ctx) ?? []) as ClientRow[]
  const summary = (
    <RemoteSummary verb="clients">
      <Meta>
        {clients.length} opted in{clients.length === 0 ? ' (nobody to drive)' : ''}
      </Meta>
    </RemoteSummary>
  )
  const details = clients.length ? (
    <RowList>
      {clients.map(c => (
        <div key={c.clientId} className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-green-400 shrink-0" />
          <span className="text-foreground/80 truncate">{c.label || c.clientId}</span>
          {c.userName && <span className="text-muted-foreground/70">{c.userName}</span>}
          {typeof c.ttlMs === 'number' && <Meta>{Math.round(c.ttlMs / 60000)}m left</Meta>}
        </div>
      ))}
    </RowList>
  ) : null
  return { summary, details }
}

interface CommandRow {
  id?: string
  label?: string
  group?: string
}

export function renderWebListCommands(ctx: ToolCaseInput): ToolCaseResult {
  const commands = (payloadArray(ctx) ?? []) as CommandRow[]
  const summary = (
    <RemoteSummary verb="commands">
      <Meta>{commands.length} registered</Meta>
    </RemoteSummary>
  )
  const details = commands.length ? (
    <RowList>
      {commands.map(c => (
        <div key={c.id} className="flex items-center gap-2">
          <span className="text-amber-400/80 shrink-0">{c.id}</span>
          <span className="text-foreground/70 truncate">{c.label}</span>
          {c.group && <Meta>{c.group}</Meta>}
        </div>
      ))}
    </RowList>
  ) : null
  return { summary, details }
}

export function renderWebExecuteCommand(ctx: ToolCaseInput): ToolCaseResult {
  const args = Array.isArray(ctx.input.args) ? (ctx.input.args as unknown[]).map(String) : []
  const summary = (
    <RemoteSummary verb="run" tone="text-amber-400">
      <span className="text-foreground/90 truncate">{(ctx.input.id as string) || 'command'}</span>
      {args.length > 0 && <Meta>{args.join(' ')}</Meta>}
    </RemoteSummary>
  )
  return { summary, details: null }
}

export function renderWebSetConversation(ctx: ToolCaseInput): ToolCaseResult {
  const summary = (
    <RemoteSummary verb="go to">
      <ConversationTag idOrSlug={(ctx.input.conversationId as string) || ''} />
    </RemoteSummary>
  )
  return { summary, details: null }
}

export function renderWebSendPrompt(ctx: ToolCaseInput): ToolCaseResult {
  const text = (ctx.input.text as string) || ''
  const summary = (
    <RemoteSummary verb="prompt" tone="text-green-400">
      <ConversationTag idOrSlug={(ctx.input.conversationId as string) || ''} />
      <span className="truncate text-foreground/80">{text}</span>
    </RemoteSummary>
  )
  const details = text ? (
    <div className="text-[10px] font-mono bg-green-500/5 border border-green-500/20 rounded px-2.5 py-1.5 whitespace-pre-wrap break-words text-foreground/80">
      {text}
    </div>
  ) : null
  return { summary, details }
}

export function renderWebReadTranscript(ctx: ToolCaseInput): ToolCaseResult {
  const payload = payloadObject(ctx)
  const count = typeof payload?.count === 'number' ? payload.count : undefined
  const conversationId = (payload?.conversationId as string) || (ctx.input.conversationId as string) || ''
  const summary = (
    <RemoteSummary verb="read">
      {conversationId ? <ConversationTag idOrSlug={conversationId} /> : <Meta>active conversation</Meta>}
      {count !== undefined && <Meta>{count} entries</Meta>}
    </RemoteSummary>
  )
  let details: ReactNode = null
  if (typeof payload?.text === 'string') details = <TruncatedPre text={payload.text} tool="MCP" />
  else if (Array.isArray(payload?.entries)) details = <Meta>{payload.entries.length} raw entries (JSON)</Meta>
  return { summary, details }
}
