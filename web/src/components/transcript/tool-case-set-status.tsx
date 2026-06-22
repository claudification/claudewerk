import { Fragment } from 'react'
import { Markdown } from '@/components/markdown'
import { STATUS_FIELDS, STATUS_META } from '@/lib/status-style'
import type { LiveStatusState } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'

/**
 * THE STATUS in the transcript — the agent's `set_status` self-report is the
 * conversation's FINAL HANDOFF signal, so it renders as a prominent always-on
 * card (inlineContent, never tucked behind the "output" expander): a state-
 * colored header + each populated field rendered as Markdown. The collapsed row
 * `summary` is just the state pill — everything else lives in the card, so there
 * is no row/card duplication. Shares STATUS_META with the conversation-list badge.
 */

function resolveState(raw: unknown): LiveStatusState {
  return typeof raw === 'string' && raw in STATUS_META ? (raw as LiveStatusState) : 'working'
}

function HandoffCard({ input, state }: { input: Record<string, unknown>; state: LiveStatusState }) {
  const meta = STATUS_META[state]
  const safeToClose = input.safe_to_close === true
  const fields = STATUS_FIELDS.filter(f => typeof input[f.key] === 'string' && input[f.key])
  return (
    <div className={cn('mt-1.5 overflow-hidden rounded-md border', meta.border, meta.bg)}>
      <div className={cn('flex items-center gap-2.5 border-b px-3.5 py-2', meta.border)}>
        <span className={cn('inline-flex items-center gap-1.5 text-sm font-bold tracking-wide', meta.text)}>
          <span className={cn('h-2 w-2 rounded-full', meta.dot)} />
          {meta.label}
        </span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/50">status handoff</span>
        {safeToClose && (
          <span
            className="ml-auto text-[10px] font-bold text-muted-foreground"
            title="Agent reports this conversation is safe to close — nothing in flight"
          >
            {'✕ CLOSEABLE'}
          </span>
        )}
      </div>
      {fields.length > 0 && (
        <div className="grid grid-cols-[4.5rem_1fr] gap-x-4 gap-y-3 px-3.5 py-3">
          {fields.map(f => (
            <Fragment key={f.key}>
              <span className={cn('pt-px text-right text-[10px] font-bold uppercase tracking-wide', f.tone)}>
                {f.label}
              </span>
              <div className="min-w-0 text-[13px] leading-relaxed [&_a]:underline [&_li]:my-0 [&_ol]:my-1 [&_p]:my-0 [&_pre]:my-1.5 [&_ul]:my-1">
                <Markdown>{input[f.key] as string}</Markdown>
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

export function renderMcpSetStatus({ input }: ToolCaseInput): ToolCaseResult {
  const state = resolveState(input.state)
  const meta = STATUS_META[state]
  const summary = (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold',
        meta.text,
        meta.bg,
        meta.border,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  )
  return { summary, inlineContent: <HandoffCard input={input} state={state} />, details: null }
}
