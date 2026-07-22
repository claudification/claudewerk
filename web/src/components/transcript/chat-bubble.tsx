import { cn } from '@/lib/utils'
import { CopyMenu } from '../copy-menu'
import { Markdown } from '../markdown'
import type { RenderItem } from './group-view-types'
import { BUBBLE_COLORS } from './group-view-types'
import { TimeStamp } from './timestamp'

export function ChatBubble({
  items,
  ts,
  bubbleColor,
  sizeClass,
  queued,
  channelServer,
  effortBadge,
}: {
  items: RenderItem[]
  ts?: string | number
  bubbleColor: string
  sizeClass: string
  queued?: boolean
  channelServer?: string
  effortBadge: { symbol: string; label: string } | null
}) {
  const bubbleBg = BUBBLE_COLORS[bubbleColor] || BUBBLE_COLORS.blue
  const source = items
    .filter((item): item is Extract<RenderItem, { kind: 'text' }> => item.kind === 'text')
    .map(item => item.text)
    .join('\n\n')

  return (
    <div className="mb-3 flex justify-end">
      <div className={cn('group/bubble max-w-[85%] sm:max-w-[75%]', queued && 'opacity-50')}>
        <div className={cn('rounded-2xl rounded-br-sm px-4 py-2.5 text-white', bubbleBg, sizeClass)}>
          {items.map((item, i) => {
            if (item.kind === 'text') {
              const hasBlocks = /^```/m.test(item.text) || /^\|.*\|.*\|/m.test(item.text)
              return (
                <div
                  // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
                  // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                  key={i}
                  // [&_code] styles inline code chips; [&_pre_code] re-zeros them
                  // for fenced blocks -- inline padding on a wrapped <code> bleeds
                  // its left-padding onto the first visual line only, indenting it.
                  className="text-sm [&_a]:text-primary-foreground/85 [&_a]:underline [&_a]:decoration-primary-foreground/40 [&_code]:!bg-black/25 [&_code]:!px-1.5 [&_code]:!py-0.5 [&_code]:!rounded-sm [&_code]:!text-primary-foreground/80 [&_code]:!text-[0.85em] [&_pre_code]:!bg-transparent [&_pre_code]:!p-0 [&_pre_code]:!rounded-none [&_pre_code]:!text-[0.95em] [&_.conversation-pill]:!text-white [&_.conversation-pill]:!bg-black/20 [&_.conversation-pill]:!border-white/30 [&_.conversation-pill]:hover:!bg-black/30"
                >
                  <Markdown inline={!hasBlocks}>{item.text}</Markdown>
                </div>
              )
            }
            if (item.kind === 'images') {
              return (
                // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
                // biome-ignore lint/suspicious/noArrayIndexKey: content blocks without stable IDs
                <div key={i} className="flex gap-1 flex-wrap mt-1">
                  {item.images.map(img => (
                    <img key={img.hash} src={img.url} alt="" className="max-h-24 rounded" />
                  ))}
                </div>
              )
            }
            return null
          })}
        </div>
        <div className="flex items-center justify-end gap-1.5 mt-0.5 px-1">
          {source && (
            <CopyMenu
              text={source}
              iconClassName="w-2.5 h-2.5"
              className="opacity-60 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/bubble:opacity-60 hover:!opacity-100 transition-opacity"
            />
          )}
          <TimeStamp ts={ts} className="text-muted-foreground/50 text-[9px]" />
          {channelServer === 'rclaude' && <span className="text-teal-400/40 text-[9px]">channel</span>}
          {effortBadge && <span className="text-orange-400/60 text-[9px]">{effortBadge.symbol}</span>}
        </div>
      </div>
    </div>
  )
}
