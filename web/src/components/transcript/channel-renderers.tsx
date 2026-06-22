import { cn } from '@/lib/utils'
import { Markdown } from '../markdown'
import { ChannelBodyCard, DirectionChip, IntentBadge } from './channel-message-parts'
import { ConversationTag } from './conversation-tag'
import { DialogChannel, DialogSubmitChannel } from './dialog-channels'
import type { RenderItem } from './group-view-types'

type ChannelRenderItem = Extract<RenderItem, { kind: 'channel' }>

export function ChannelItem({ item }: { item: ChannelRenderItem }) {
  if (item.isInterConversation) {
    return <InterConversationChannel item={item} />
  }
  if (item.isDialogSubmit) {
    return <DialogSubmitChannel item={item} />
  }
  if (item.isDialog) {
    return <DialogChannel item={item} />
  }
  if (item.isSystem) {
    return <SystemChannel item={item} />
  }
  return (
    <div className="text-sm border-l-2 border-teal-400/40 pl-3 py-1">
      <div className="text-[10px] text-teal-400/70 uppercase font-bold tracking-wider mb-1">channel: {item.source}</div>
      <Markdown>{item.text}</Markdown>
    </div>
  )
}

// INCOMING -- message received from another conversation. Direction "in":
// teal hue, left edge accent, `◀ IN` chip. See channel-message-parts.tsx for
// the matching outgoing treatment.
function InterConversationChannel({ item }: { item: ChannelRenderItem }) {
  return (
    <ChannelBodyCard direction="in">
      <div className="flex items-center gap-2 mb-1.5">
        <DirectionChip direction="in" />
        <span className="text-[10px] font-mono text-teal-400/60">from</span>
        <ConversationTag idOrSlug={item.conversationId || item.source || ''} className="text-xs" />
        <IntentBadge intent={item.intent} />
      </div>
      <div className="text-sm">
        <Markdown copyable>{item.text}</Markdown>
      </div>
    </ChannelBodyCard>
  )
}

const SYSTEM_CHANNEL_STYLES: Record<string, string> = {
  timeout: 'border-amber-500/40 bg-amber-500/5 text-amber-300/90',
  error: 'border-red-500/40 bg-red-500/5 text-red-300/90',
  failed: 'border-red-500/40 bg-red-500/5 text-red-300/90',
  ok: 'border-green-500/40 bg-green-500/5 text-green-300/90',
  success: 'border-green-500/40 bg-green-500/5 text-green-300/90',
  'recap-completed': 'border-teal-500/40 bg-teal-500/5 text-teal-200/90',
}
const DEFAULT_SYSTEM_CHANNEL_STYLE = 'border-zinc-500/40 bg-zinc-500/5 text-zinc-300/90'

function RecapOpenButton({ recapId }: { recapId: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('rclaude-recap-open', { detail: { recapId } }))}
      className="mt-1.5 rounded border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-teal-300 hover:bg-teal-500/25"
    >
      Open recap
    </button>
  )
}

function SystemChannel({ item }: { item: ChannelRenderItem }) {
  const isRecap = item.systemKind === 'recap-completed'
  const style = (item.systemKind && SYSTEM_CHANNEL_STYLES[item.systemKind]) || DEFAULT_SYSTEM_CHANNEL_STYLE
  return (
    <div className={cn('text-sm rounded-md border-l-2 px-3 py-2 my-1', style)}>
      <div className="text-[10px] uppercase font-bold tracking-wider mb-1 opacity-70">
        {isRecap ? 'recap ready' : `system${item.systemKind ? ` · ${item.systemKind}` : ''}`}
      </div>
      <Markdown>{item.text}</Markdown>
      {isRecap && item.recapId && <RecapOpenButton recapId={item.recapId} />}
    </div>
  )
}
