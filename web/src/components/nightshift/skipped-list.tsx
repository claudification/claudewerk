import type { NightshiftSkipped } from '@shared/nightshift-types'

interface Props {
  items: NightshiftSkipped[]
}

function FeasibilityBadge({ f }: { f: string }) {
  const color =
    f === 'feasible'
      ? 'text-green-400 border-green-800'
      : f === 'uncertain'
        ? 'text-yellow-400 border-yellow-800'
        : 'text-red-400 border-red-800'
  return <span className={`text-xs font-mono border rounded px-1 py-0.5 ${color}`}>{f}</span>
}

export function SkippedList({ items }: Props) {
  return (
    <ul className="space-y-1.5">
      {items.map(item => (
        <li key={item.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span className="font-mono text-xs text-muted-foreground shrink-0">#{item.id}</span>
          <span className="text-muted-foreground">{item.title}</span>
          <span className="text-xs text-muted-foreground/70">-- {item.reason}</span>
          <FeasibilityBadge f={item.feasibility} />
        </li>
      ))}
    </ul>
  )
}
