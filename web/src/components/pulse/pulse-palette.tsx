import { useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useKeyLayer } from '@/lib/key-layers'
import type { PulseBand } from '@/lib/pulse/bands'
import { cn } from '@/lib/utils'
import { PulseBandsView } from './pulse-bands-view'
import { PulseFooter } from './pulse-footer'
import { PulsePaletteHeader } from './pulse-palette-header'
import { PulseTideView } from './pulse-tide-view'
import { type PulseRow, usePulseFleet } from './use-pulse-fleet'
import { usePulseKeys } from './use-pulse-keys'

/** Band -> the grammar token its chip writes. Chips are a shortcut for typing,
 *  never a second filter mechanism. */
const CHIP_TOKEN: Record<PulseBand, string> = {
  needs: '!',
  working: '!!',
  done: '',
  idle: '',
  expired: '',
}

interface PulsePaletteProps {
  onOpen: (conversationId: string) => void
  onClose: () => void
}

export function PulsePalette({ onOpen, onClose }: PulsePaletteProps) {
  const [filter, setFilter] = useState('')
  const [board, setBoard] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const view = useConversationsStore(s => s.controlPanelPrefs.pulseView)
  const fleet = usePulseFleet(filter)

  const select = (row: PulseRow) => {
    onOpen(row.conversation.id)
    onClose()
  }
  const keys = usePulseKeys(fleet.flat, select)

  useKeyLayer({ Escape: onClose }, { id: 'pulse-palette' })

  /** `>` is the command palette's prefix, not ours — hand the query off intact
   *  rather than shadowing it. Done on input, never during render. */
  function handleChange(value: string) {
    if (value.startsWith('>')) {
      onClose()
      useConversationsStore.getState().openSwitcherWithFilter(value)
      return
    }
    setFilter(value)
  }

  function pickBand(band: PulseBand | null) {
    setFilter(band ? CHIP_TOKEN[band] : '')
    inputRef.current?.focus()
  }

  function appendToken(token: string) {
    setFilter(prev => (prev ? `${prev.trimEnd()} ${token}` : token))
    inputRef.current?.focus()
  }

  const hover = (row: PulseRow) => keys.setActiveId(row.id)

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay closes on click
    <div
      role="presentation"
      className="fixed inset-0 z-[60] flex items-start justify-center sm:pt-[12vh]"
      onClick={onClose}
    >
      {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role, react-doctor/prefer-html-dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pulse — the fleet"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => {
          e.stopPropagation()
          keys.handleKeyDown(e)
        }}
        className={cn(
          'w-full bg-surface-inset border border-primary/20 shadow-2xl flex flex-col',
          // mobile: full-height sheet with the input pinned to the thumb
          'h-dvh sm:h-auto flex-col-reverse sm:flex-col sm:max-h-[74vh]',
          board ? 'sm:max-w-5xl' : 'sm:max-w-2xl',
        )}
      >
        <PulsePaletteHeader
          filter={filter}
          onFilterChange={handleChange}
          inputRef={inputRef}
          liveCount={fleet.flat.length}
          totals={fleet.totals}
          activeBands={fleet.query.bands}
          onPickBand={pickBand}
          view={view}
          onToggleView={() =>
            useConversationsStore.getState().updateControlPanelPrefs({ pulseView: view === 'tide' ? 'bands' : 'tide' })
          }
          board={board}
          onToggleBoard={() => setBoard(v => !v)}
        />

        <div className="flex-1 min-h-0 overflow-y-auto">
          {view === 'tide' ? (
            <PulseTideView fleet={fleet} activeId={keys.activeId} onSelect={select} onHover={hover} />
          ) : (
            <PulseBandsView
              fleet={fleet}
              activeId={keys.activeId}
              onSelect={select}
              onHover={hover}
              board={board}
              onRevealManaged={() => appendToken('+over')}
            />
          )}
        </div>

        <PulseFooter onSigil={appendToken} />
      </div>
    </div>
  )
}
