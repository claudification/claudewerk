/**
 * Remote-control renderers -- the "probe the page" ops: execute_script,
 * screenshot, perf monitor/report.
 */

import type { ReactNode } from 'react'
import JsonHighlight from '@/components/json-highlight'
import { Markdown } from '@/components/markdown'
import { TruncatedPre } from './shared'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'
import { ReplView } from './tool-renderers'
import { Meta, payloadObject, RemoteSummary, ShotView } from './web-remote-shared'

function JsonBlock({ data }: { data: unknown }) {
  return (
    <div className="text-[10px] font-mono bg-black/30 rounded px-2.5 py-2 overflow-x-auto">
      <pre className="whitespace-pre-wrap">
        <JsonHighlight data={data} />
      </pre>
    </div>
  )
}

/** The script itself renders inline (syntax-highlighted, same as REPL); the
 *  returned value renders as JSON below instead of a re-escaped string blob. */
export function renderWebExecuteScript(ctx: ToolCaseInput): ToolCaseResult {
  const code = (ctx.input.code as string) || ''
  const timeoutMs = ctx.input.timeoutMs as number | undefined
  const lines = code ? code.split('\n').length : 0
  const summary = (
    <RemoteSummary verb="script" tone="text-cyan-400">
      <Meta>
        {lines} {lines === 1 ? 'line' : 'lines'} · {code.length} chars
        {timeoutMs ? ` · ${Math.round(timeoutMs / 1000)}s timeout` : ''}
      </Meta>
    </RemoteSummary>
  )

  const payload = payloadObject(ctx)
  const value = payload && 'result' in payload ? payload.result : undefined
  let details: ReactNode = null
  if (value !== undefined && value !== null) {
    details = typeof value === 'object' ? <JsonBlock data={value} /> : <TruncatedPre text={String(value)} tool="MCP" />
  } else if (ctx.result && !payload) {
    details = <TruncatedPre text={ctx.result} tool="MCP" />
  } else if (payload) {
    details = <Meta>no return value</Meta>
  }

  return { summary, details, inlineContent: code ? <ReplView code={code} isError={ctx.isError} /> : null }
}

export function renderWebScreenshot(ctx: ToolCaseInput): ToolCaseResult {
  const selector = (ctx.input.selector as string) || ''
  const summary = (
    <RemoteSummary verb="screenshot">
      <span className="truncate text-foreground/80">{selector || 'viewport'}</span>
    </RemoteSummary>
  )
  const url = payloadObject(ctx)?.url
  const details = typeof url === 'string' ? <ShotView url={url} label={selector || 'screenshot'} /> : null
  return { summary, details }
}

export function renderWebSetPerfMonitor(ctx: ToolCaseInput): ToolCaseResult {
  const on = ctx.input.enabled === true
  const summary = (
    <RemoteSummary verb="perf monitor" tone="text-violet-400">
      <span className={on ? 'text-green-400' : 'text-muted-foreground'}>{on ? 'ON' : 'OFF'}</span>
    </RemoteSummary>
  )
  return { summary, details: null }
}

export function renderWebPerfReport(ctx: ToolCaseInput): ToolCaseResult {
  const summary = (
    <RemoteSummary verb="perf report" tone="text-violet-400">
      {ctx.input.significantOnly === true && <Meta>significant only</Meta>}
    </RemoteSummary>
  )
  const report = payloadObject(ctx)?.report
  const details =
    typeof report === 'string' ? (
      <div className="text-xs prose-sm max-h-96 overflow-y-auto">
        <Markdown>{report}</Markdown>
      </div>
    ) : null
  return { summary, details }
}
