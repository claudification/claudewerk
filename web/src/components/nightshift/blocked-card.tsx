import type { NightshiftBlocked } from '@shared/nightshift-types'
import { Markdown } from '@/components/markdown'

interface Props {
  item: NightshiftBlocked
}

export function BlockedCard({ item }: Props) {
  return (
    <div className="rounded-md border border-yellow-800/60 bg-yellow-950/20 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-sm leading-snug text-yellow-300">{item.title}</span>
        <span className="shrink-0 text-xs font-mono text-muted-foreground">#{item.id}</span>
      </div>

      <p className="text-sm text-foreground">{item.question}</p>

      {item.options && item.options.length > 0 && (
        <ul className="space-y-1 pl-1">
          {item.options.map((opt, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered list
            <li key={i} className="flex gap-1.5 text-sm">
              <span className="text-muted-foreground font-mono">{String.fromCharCode(65 + i)}.</span>
              <span>{opt}</span>
            </li>
          ))}
        </ul>
      )}

      {item.body && (
        <div className="pt-1 border-t border-yellow-800/30 text-xs">
          <Markdown>{item.body}</Markdown>
        </div>
      )}
    </div>
  )
}
