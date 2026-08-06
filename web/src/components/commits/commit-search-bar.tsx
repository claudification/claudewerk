/**
 * The commit search input, shared by the conversation/project list and the
 * global browser. Enter applies, Escape clears -- deferred rather than
 * search-as-you-type because every keystroke would be an FTS query.
 */

import { Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'

interface Props {
  onApply: (text: string) => void
  /** Rendered at the right edge: a result count, filter chips, whatever. */
  trailing?: ReactNode
}

export function CommitSearchBar({ onApply, trailing }: Props) {
  const [text, setText] = useState('')

  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
      <Search className="size-3 text-muted-foreground shrink-0" />
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onApply(text.trim())
          if (e.key === 'Escape') {
            setText('')
            onApply('')
          }
        }}
        placeholder="Search messages and touched paths, then Enter"
        className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
      />
      {trailing}
    </div>
  )
}
