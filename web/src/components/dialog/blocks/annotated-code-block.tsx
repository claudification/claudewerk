/**
 * AnnotatedCode block — a code snippet (rendered via the shared Markdown fence)
 * with margin notes pinned to specific line numbers listed below the code.
 */
import { Markdown } from '@/components/markdown'
import type { AnnotatedCodeComponent } from '../types'

export function AnnotatedCodeBlock({
  code,
  language,
  filename,
  annotations,
}: Pick<AnnotatedCodeComponent, 'code' | 'language' | 'filename' | 'annotations'>) {
  const sorted = annotations ? annotations.toSorted((a, b) => a.line - b.line) : []
  return (
    <div className="rounded border border-border/30 overflow-hidden">
      {filename && (
        <div className="px-3 py-1.5 bg-muted/40 border-b border-border/30 text-xs font-mono text-muted-foreground">
          {filename}
        </div>
      )}
      <div className="overflow-x-auto text-sm [&_pre]:my-0 [&_pre]:rounded-none [&_pre]:border-0">
        <Markdown>{`\`\`\`${language || ''}\n${code}\n\`\`\``}</Markdown>
      </div>
      {sorted.length > 0 && (
        <ul className="border-t border-border/30 p-2 space-y-1 text-xs">
          {sorted.map((ann, i) => (
            <li
              // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
              // biome-ignore lint/suspicious/noArrayIndexKey: annotation rows are positional
              key={i}
              className="flex gap-2"
            >
              <span className="font-mono text-muted-foreground/70 shrink-0">L{ann.line}</span>
              <span className="text-foreground/80">{ann.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
