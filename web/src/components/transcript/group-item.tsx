/**
 * GroupItem -- dispatches one parsed RenderItem to its renderer. Split out of
 * group-view.tsx (SPLIT DISCIPLINE).
 */
import type { RenderItem } from './group-view-types'
import { BashItem, ChannelItem, ImagesItem, ProjectTaskItem, TextItem, ThinkingItem, ToolItem } from './item-renderers'
import { SystemLineInline } from './system-line'

export function GroupItem({
  item,
  showThinking,
  expandAll,
  planContext,
}: {
  item: RenderItem
  showThinking: boolean
  expandAll: boolean
  planContext?: { content: string; path?: string }
}) {
  switch (item.kind) {
    case 'thinking':
      if (!showThinking && !expandAll) return null
      return <ThinkingItem item={item} />
    case 'project-task':
      return <ProjectTaskItem item={item} />
    case 'text':
      return <TextItem item={item} />
    case 'images':
      return <ImagesItem item={item} />
    case 'channel':
      return <ChannelItem item={item} />
    case 'bash':
      return <BashItem item={item} />
    case 'tool':
      return <ToolItem item={item} expandAll={expandAll} planContext={planContext} />
    case 'system':
      return <SystemLineInline entry={item.entry} subtype={item.subtype} ts={item.timestamp} />
    default:
      return null
  }
}
