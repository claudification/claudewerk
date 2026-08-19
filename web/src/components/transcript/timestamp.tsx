import { Popover } from 'radix-ui'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import { cn, formatAge } from '@/lib/utils'

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
}

/**
 * A transcript timestamp. Renders the HH:MM:SS label (the single source of
 * truth for transcript time formatting) and, on hover, shows a legible popover
 * with the full date, exact time, and relative age. Returns null when there is
 * no timestamp (undefined or the empty-string sentinel used by the grouper),
 * matching the previous `time && <span>` behavior.
 *
 * `ts` is the raw transcript timestamp: an ISO-8601 string (the common case) or
 * an epoch-ms number. Both are accepted by `new Date(...)`.
 */
export function TimeStamp({ ts, className }: { ts?: string | number; className?: string }) {
  const { open, setOpen, handleMouseEnter, handleMouseLeave, cancelClose, toggle } = useHoverPopover(250, 150)

  if (!ts) return null

  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null

  const epoch = d.getTime()
  const time = d.toLocaleTimeString('en-US', { hour12: false })
  const date = d.toLocaleDateString('en-US', DATE_OPTS)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn('cursor-default tabular-nums', className)}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={toggle}
        >
          {time}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="z-50 rounded-md border border-border bg-popover/95 text-popover-foreground backdrop-blur-sm shadow-lg px-3 py-2 font-mono"
          sideOffset={6}
          onMouseEnter={cancelClose}
          onMouseLeave={handleMouseLeave}
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <div className="text-[13px] font-semibold whitespace-nowrap leading-tight">{date}</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground whitespace-nowrap leading-tight tabular-nums">
            {time}
          </div>
          <div className="mt-0.5 text-[11px] text-fg-muted whitespace-nowrap leading-tight">
            {formatAge(epoch)}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
