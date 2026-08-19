/**
 * ApiEndpoint block — an OpenAPI-style endpoint card: method badge + path,
 * optional description, and request/response shapes as JSON fences.
 */
import { Markdown } from '@/components/markdown'
import { cn } from '@/lib/utils'
import type { ApiEndpointComponent } from '../types'

const METHOD_COLOR: Record<string, string> = {
  GET: 'bg-blue-500/15 text-blue-500',
  POST: 'bg-emerald-500/15 text-emerald-500',
  PUT: 'bg-amber-500/15 text-amber-500',
  PATCH: 'bg-amber-500/15 text-amber-500',
  DELETE: 'bg-destructive/15 text-destructive',
}

function JsonSection({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-fg-muted">{heading}</div>
      <div className="text-xs [&_pre]:my-0">
        <Markdown>{`\`\`\`json\n${body}\n\`\`\``}</Markdown>
      </div>
    </div>
  )
}

export function ApiEndpointBlock({
  method,
  path,
  description,
  request,
  response,
}: Pick<ApiEndpointComponent, 'method' | 'path' | 'description' | 'request' | 'response'>) {
  const badge = METHOD_COLOR[method.toUpperCase()] || 'bg-muted text-muted-foreground'
  return (
    <div className="rounded border border-border-subtle overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-bold font-mono shrink-0', badge)}>
          {method.toUpperCase()}
        </span>
        <span className="font-mono text-sm truncate">{path}</span>
      </div>
      {(description || request || response) && (
        <div className="p-3 space-y-3">
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
          {request && <JsonSection heading="Request" body={request} />}
          {response && <JsonSection heading="Response" body={response} />}
        </div>
      )}
    </div>
  )
}
