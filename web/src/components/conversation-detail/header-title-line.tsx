import { useEffect, useState } from 'react'
import { rowTitle } from '@/lib/conversation-row'
import { isShareView } from '@/lib/share-mode'
import type { Conversation } from '@/lib/types'
import { haptic } from '@/lib/utils'

/**
 * The conversation's own identity, directly under the project line in the
 * collapsed header: name (prominent) + short id (dim, click-to-copy).
 * Share guests get the name only -- the id is host-side plumbing.
 */
export function HeaderTitleLine({ conversation }: { conversation: Conversation }) {
  // 200 = "don't cap here"; the CSS truncate owns the visual cut.
  const title = rowTitle(conversation, 200)

  return (
    <div className="flex items-baseline gap-2 min-w-0 px-3 sm:px-4 -mt-2 pb-1">
      <span className="text-sm font-semibold text-foreground truncate" title={title}>
        {title}
      </span>
      {!isShareView() && <IdChip id={conversation.id} />}
    </div>
  )
}

function IdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <button
      type="button"
      className="shrink-0 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground transition-colors cursor-pointer"
      title={`${id} -- click to copy`}
      onClick={() => {
        navigator.clipboard.writeText(id).then(() => {
          haptic('success')
          setCopied(true)
        })
      }}
    >
      {copied ? 'copied' : id.slice(0, 8)}
    </button>
  )
}
