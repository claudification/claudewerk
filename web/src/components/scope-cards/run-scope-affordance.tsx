import { useState } from 'react'
import { HoverCard } from '@/components/ui/hover-card'
import type { Conversation } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { useIsMobile } from '../input-editor/shell/use-is-mobile'
import { ConversationInfoDialog } from '../project-list/conversation-info-dialog'
import { RunCard } from './run-card'

/**
 * The ⓘ hit-target on a conversation row -- one affordance, two surfaces:
 *
 *   pointer: hover floats the RUN card; a click opens the full info dialog
 *   touch:   TAP floats the RUN card (hover does not exist on a phone), and the
 *            card's `full info ►` link keeps the dialog reachable
 *
 * A card that only exists on desktop is half a feature, hence the tap path.
 */
export function RunScopeAffordance({ conversation, visible }: { conversation: Conversation; visible: boolean }) {
  const [infoOpen, setInfoOpen] = useState(false)
  const isMobile = useIsMobile()

  return (
    <>
      <HoverCard
        openOnTap={isMobile}
        panel={() => <RunCard conversation={conversation} onOpenInfo={() => setInfoOpen(true)} />}
        className="shrink-0"
      >
        {({ close }) => {
          // The dialog renders BELOW the floating panel (z-50 vs z-120), so the
          // card must get out of the way as the dialog opens.
          const openInfo = () => {
            close()
            haptic('tap')
            setInfoOpen(true)
          }
          return (
            // nested inside conversation-row interactive; semantic <button> would be invalid HTML
            // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
            <span
              role="button"
              tabIndex={0}
              className={cn(
                'text-[10px] text-fg-dim hover:text-accent cursor-pointer transition-all shrink-0',
                visible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
              )}
              title="Conversation info"
              onClick={e => {
                // On touch the tap belongs to the card: let it bubble to the
                // HoverCard trigger (which toggles and stops propagation itself).
                if (isMobile) return
                e.stopPropagation()
                openInfo()
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  openInfo()
                }
              }}
            >
              {'ⓘ'}
            </span>
          )
        }}
      </HoverCard>
      <ConversationInfoDialog conversation={conversation} open={infoOpen} onOpenChange={setInfoOpen} />
    </>
  )
}
