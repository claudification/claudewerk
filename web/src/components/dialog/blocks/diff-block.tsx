/**
 * Diff block — renders unified diff text via the shared Markdown `diff` fence
 * (Shiki colors +/- lines). Optional filename heading.
 */
import { Markdown } from '@/components/markdown'
import type { DiffComponent } from '../types'

export function DiffBlock({ content, filename }: Pick<DiffComponent, 'content' | 'filename'>) {
  return (
    <div className="rounded border border-border-subtle overflow-hidden">
      {filename && (
        <div className="px-3 py-1.5 bg-muted/40 border-b border-border-subtle text-xs font-mono text-muted-foreground">
          {filename}
        </div>
      )}
      <div className="overflow-x-auto text-sm [&_pre]:my-0 [&_pre]:rounded-none [&_pre]:border-0">
        <Markdown>{`\`\`\`diff\n${content}\n\`\`\``}</Markdown>
      </div>
    </div>
  )
}
