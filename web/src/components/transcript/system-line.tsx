import { JsonInspector } from '../json-inspector'
import type { DisplayGroup } from './grouping'
import type { TextResult } from './system-entry'
import { describeSystemEntry } from './system-entry'
import { TimeStamp } from './timestamp'

// Per-subtype formatting lives in ./system-entry (one describer map per theme).
// This file owns only the two chrome variants: a centered standalone line, and
// the left-aligned one folded into a running assistant group.

function SystemText({ result }: { result: TextResult }) {
  const body = result.href ? (
    <a
      href={result.href}
      target="_blank"
      rel="noreferrer noopener"
      className={`${result.color} underline decoration-dotted underline-offset-2 hover:decoration-solid`}
    >
      {result.text}
    </a>
  ) : (
    <span className={result.color}>{result.text}</span>
  )
  if (!result.icon) return body
  return (
    <span className={`inline-flex items-center gap-1 ${result.color}`}>
      {result.icon}
      {body}
    </span>
  )
}

export function SystemLine({ group, ts }: { group: DisplayGroup; ts?: string | number }) {
  const entry = group.entries[0] as Record<string, unknown>
  const sub = group.systemSubtype || ''
  const result = describeSystemEntry(sub, entry, ts)
  if (!result) return null
  if (result.kind === 'jsx') return result.node

  return (
    <div className="mb-1 flex items-center justify-center gap-2 text-[10px]">
      <SystemText result={result} />
      <TimeStamp ts={ts} className="text-muted-foreground/40" />
      <JsonInspector title={sub || 'system'} data={entry} raw={entry} />
    </div>
  )
}

// Inline variant rendered inside an assistant group's body. Left-aligned,
// tighter margin, same content + color as the standalone SystemLine.
export function SystemLineInline({
  entry,
  subtype,
  ts,
}: {
  entry: Record<string, unknown>
  subtype: string
  ts?: string | number
}) {
  const result = describeSystemEntry(subtype, entry, ts)
  if (!result) return null
  if (result.kind === 'jsx') return result.node

  return (
    <div className="flex items-center gap-2 text-[10px]">
      <SystemText result={result} />
      <TimeStamp ts={ts} className="text-muted-foreground/40" />
      <JsonInspector title={subtype || 'system'} data={entry} raw={entry} />
    </div>
  )
}
