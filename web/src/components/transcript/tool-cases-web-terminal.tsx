/**
 * Remote-control renderers -- host-shell ops driven through the opted-in
 * browser (list / start / attach / detach / read / write / screenshot).
 */

import { shortPath, TruncatedPre } from './shared'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'
import { Meta, payloadObject, RemoteSummary, RowList, ShellId, ShotView, visibleBytes } from './web-remote-shared'

const TERM_TONE = 'text-orange-400'

interface ShellRow {
  shellId?: string
  title?: string
  path?: string
  status?: string
  agentAttached?: boolean
  readable?: boolean
}

export function renderWebTerminalList(ctx: ToolCaseInput): ToolCaseResult {
  const shells = (payloadObject(ctx)?.shells ?? []) as ShellRow[]
  const summary = (
    <RemoteSummary verb="shells" tone={TERM_TONE}>
      <Meta>{shells.length} on host</Meta>
    </RemoteSummary>
  )
  const details = shells.length ? (
    <RowList>
      {shells.map(s => (
        <div key={s.shellId} className="flex items-center gap-2">
          <span
            className={`size-1.5 rounded-full shrink-0 ${s.status === 'running' ? 'bg-green-400' : 'bg-zinc-600'}`}
          />
          <ShellId id={s.shellId} />
          <span className="text-foreground/80 truncate">{s.title}</span>
          {s.path && <Meta>{shortPath(s.path)}</Meta>}
          {s.agentAttached && <span className="text-fuchsia-400/80 shrink-0">attached</span>}
        </div>
      ))}
    </RowList>
  ) : null
  return { summary, details }
}

export function renderWebTerminalStart(ctx: ToolCaseInput): ToolCaseResult {
  const projectUri = (ctx.input.projectUri as string) || ''
  const summary = (
    <RemoteSummary verb="new shell" tone={TERM_TONE}>
      {ctx.input.title ? <span className="text-foreground/80 truncate">{ctx.input.title as string}</span> : null}
      <Meta>{shortPath(projectUri.replace(/^claude:\/\/[^/]*/, ''))}</Meta>
      <ShellId id={payloadObject(ctx)?.shellId as string | undefined} />
    </RemoteSummary>
  )
  return { summary, details: null }
}

export function renderWebTerminalAttach(name: string, ctx: ToolCaseInput): ToolCaseResult {
  const detach = name.endsWith('detach')
  const summary = (
    <RemoteSummary verb={detach ? 'detach' : 'attach'} tone={detach ? 'text-muted-foreground' : TERM_TONE}>
      <ShellId id={ctx.input.shellId as string | undefined} />
    </RemoteSummary>
  )
  return { summary, details: null }
}

export function renderWebTerminalRead(ctx: ToolCaseInput): ToolCaseResult {
  const text = payloadObject(ctx)?.text
  const lines = typeof text === 'string' ? text.split('\n').length : 0
  const summary = (
    <RemoteSummary verb="read shell" tone={TERM_TONE}>
      <ShellId id={ctx.input.shellId as string | undefined} />
      {lines > 0 && <Meta>{lines} lines</Meta>}
    </RemoteSummary>
  )
  const details = typeof text === 'string' ? <TruncatedPre text={text} tool="Bash" /> : null
  return { summary, details }
}

export function renderWebTerminalWrite(ctx: ToolCaseInput): ToolCaseResult {
  const data = (ctx.input.data as string) || ''
  const summary = (
    <RemoteSummary verb="type" tone={TERM_TONE}>
      <ShellId id={ctx.input.shellId as string | undefined} />
      <span className="truncate text-foreground/90">{visibleBytes(data)}</span>
    </RemoteSummary>
  )
  return { summary, details: null }
}

export function renderWebTerminalScreenshot(ctx: ToolCaseInput): ToolCaseResult {
  const shellId = ctx.input.shellId as string | undefined
  const summary = (
    <RemoteSummary verb="shell shot" tone={TERM_TONE}>
      <ShellId id={shellId} />
    </RemoteSummary>
  )
  const url = payloadObject(ctx)?.url
  const details = typeof url === 'string' ? <ShotView url={url} label={`shell ${shellId ?? ''}`} /> : null
  return { summary, details }
}
