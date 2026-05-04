import {
  GmailDraftResult,
  GmailLabelResult,
  GmailSearchResults,
  GmailSendResult,
  GmailThreadView,
} from './gmail-renderers'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'

export function renderGmailSearchEmails({ input, result, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const q = (input.query as string) || ''
  const max = input.maxResults as number | undefined
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className="truncate">{q || 'search'}</span>
      {max && <span className="text-muted-foreground/50 text-[10px]">max {max}</span>}
    </span>
  )
  const details = result ? <GmailSearchResults result={result} extra={toolUseResult} /> : null
  return { summary, details }
}

export function renderGmailGetThread({ input, result, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const tid = (input.threadId as string) || ''
  const fmt = (input.format as string) || 'full'
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground/60 font-mono text-[10px]">{tid.slice(0, 10)}</span>
      <span className="text-muted-foreground/40 text-[10px]">{fmt}</span>
    </span>
  )
  const details = result ? <GmailThreadView result={result} extra={toolUseResult} /> : null
  return { summary, details }
}

export function renderGmailDraftEmail({ input, result, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const to = (input.to as string) || ''
  const subj = (input.subject as string) || ''
  const summary = to ? `${to} -- ${subj || '(no subject)'}` : 'drafts'
  const details = result ? <GmailDraftResult result={result} extra={toolUseResult} /> : null
  return { summary, details }
}

export function renderGmailLabelOp({ input, result, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const labelName = (input.labelName as string) || (input.label as string) || ''
  const msgId = (input.messageId as string) || (input.threadId as string) || ''
  const summary = (
    <span className="flex items-center gap-1.5">
      {labelName && <span className="text-amber-400/80">{labelName}</span>}
      {msgId && <span className="text-muted-foreground/50 font-mono text-[10px]">{msgId.slice(0, 10)}</span>}
    </span>
  )
  const details = result ? <GmailLabelResult result={result} extra={toolUseResult} /> : null
  return { summary, details }
}

export function renderGmailListLabels({ result, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const details = result ? <GmailLabelResult result={result} extra={toolUseResult} /> : null
  return { summary: 'list labels', details }
}

export function renderGmailInbox(name: string, { result, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const summary = name.includes('list') ? 'list inbox' : 'inbox with threads'
  const details = result ? <GmailSearchResults result={result} extra={toolUseResult} /> : null
  return { summary, details }
}

export function renderGmailSend({ input, result, toolUseResult }: ToolCaseInput): ToolCaseResult {
  const to = Array.isArray(input.to) ? (input.to as string[]).join(', ') : (input.to as string) || ''
  const subj = (input.subject as string) || ''
  const summary = (
    <span className="flex items-center gap-1.5">
      <span className="text-blue-400/80 truncate">{to}</span>
      {subj && <span className="text-foreground/60 truncate">{subj}</span>}
    </span>
  )
  const details = result ? <GmailSendResult input={input} result={result} extra={toolUseResult} /> : null
  return { summary, details }
}
