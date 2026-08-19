/**
 * FileTree block — renders a flat list of paths as an indented tree, with a
 * per-entry change status dot and optional note. Indentation is RELATIVE: the
 * common directory prefix shared by every entry is stripped first, so a list of
 * files that all live deep under one folder reads flat instead of cascading off
 * the right edge. Only the depth that actually DIFFERS between entries indents.
 */
import { cn } from '@/lib/utils'
import type { FileTreeComponent } from '../types'
import { STATUS_DOT, STATUS_TEXT } from './block-status'

/** Number of leading DIRECTORY segments shared by every entry (basename never
 *  counts -- a single file, or files sharing a folder, must not self-indent). */
function commonDirDepth(dirSegments: string[][]): number {
  if (dirSegments.length === 0) return 0
  let depth = 0
  for (;;) {
    const seg = dirSegments[0][depth]
    if (seg === undefined) return depth
    if (dirSegments.every(d => d[depth] === seg)) depth++
    else return depth
  }
}

export function FileTreeBlock({ label, entries }: Pick<FileTreeComponent, 'label' | 'entries'>) {
  const dirSegments = entries.map(e => e.path.split('/').filter(Boolean).slice(0, -1))
  const common = commonDirDepth(dirSegments)
  return (
    <div className="rounded border border-border-subtle overflow-hidden">
      {label && (
        <div className="px-3 py-1.5 bg-muted/40 border-b border-border-subtle text-xs font-medium text-muted-foreground">
          {label}
        </div>
      )}
      <div className="p-2 font-mono text-xs space-y-0.5">
        {entries.map((entry, i) => {
          const segments = entry.path.split('/').filter(Boolean)
          const depth = Math.max(0, segments.length - 1 - common)
          const name = segments[segments.length - 1] || entry.path
          const status = entry.status ?? 'unchanged'
          return (
            <div
              // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
              // biome-ignore lint/suspicious/noArrayIndexKey: file-tree rows are positional
              key={i}
              className="flex items-center gap-2"
              style={{ paddingLeft: `${depth * 14}px` }}
            >
              <span className={cn('size-1.5 rounded-full shrink-0', STATUS_DOT[status])} />
              <span className={cn('truncate', STATUS_TEXT[status])}>{name}</span>
              {entry.note && <span className="text-fg-dim truncate">— {entry.note}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
