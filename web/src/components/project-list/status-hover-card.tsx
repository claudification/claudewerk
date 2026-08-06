import type { ReactNode } from 'react'
import { HoverCard } from '@/components/ui/hover-card'
import { isStatusSuperseded } from '@/lib/status-style'
import type { LiveStatus } from '@/lib/types'
import { StatusHoverPanel } from './status-hover-panel'

/**
 * THE STATUS hover card — wraps a status badge/glyph and floats a Markdown-
 * rendered detail panel (StatusHoverPanel) on hover/focus, replacing the native
 * `title` tooltip (which showed raw markdown source).
 *
 * All of the floating behaviour (portal, open delay, flip-above, dismissal)
 * lives in the shared `HoverCard` shell; this file is now just the content pack.
 */
export function StatusHoverCard({
  status,
  lastInputAt,
  children,
}: {
  status: LiveStatus
  lastInputAt?: number
  children: ReactNode
}) {
  const superseded = isStatusSuperseded(status, lastInputAt)
  return (
    <HoverCard panel={() => <StatusHoverPanel status={status} lastInputAt={lastInputAt} superseded={superseded} />}>
      {children}
    </HoverCard>
  )
}
