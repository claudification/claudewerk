import { FolderPlus } from 'lucide-react'
import { useKeyLayer } from '@/lib/key-layers'
import { haptic } from '@/lib/utils'
import { FooterHints } from './footer-hints'
import { PaletteResults } from './palette-results'
import { applyDoubleSpaceGesture } from './space-prefix'
import type { CommandPaletteProps } from './types'
import { useCommandPalette } from './use-command-palette'
import { useScrollActiveIntoView } from './use-scroll-active-into-view'

const PLACEHOLDER: Record<string, string> = {
  theme: 'Select theme (arrows to preview, enter to apply, esc to revert)...',
  command: 'Type a command...',
  spawn: 'Path to spawn (e.g. projects/my-app or /absolute/path)...',
  task: 'Search project tasks...',
}
const PLACEHOLDER_FALLBACK = 'Search conversations + commands... (>cmd  @tasks  S:spawn  ␣␣ cmd)'

export function CommandPalette({ onSelect, onClose }: CommandPaletteProps) {
  const palette = useCommandPalette(onClose)
  const resultsRef = useScrollActiveIntoView(palette.activeIndex, palette.mode)

  useKeyLayer(
    {
      Escape: () => {
        if (palette.mode === 'theme') {
          palette.themeRevert()
          palette.setFilter('>')
          palette.setActiveIndex(0)
        } else {
          onClose()
        }
      },
    },
    { id: 'command-palette' },
  )

  /** Raw typing, except for the double-space mode gesture (see space-prefix.ts). */
  function handleChange(value: string) {
    const gesture = applyDoubleSpaceGesture(value)
    if (gesture !== null) haptic('tap')
    palette.setFilter(gesture ?? value)
    palette.setActiveIndex(0)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay closes on click
    <div
      role="presentation"
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      {/* React-controlled modal; native <dialog> open/close API is incompatible with this overlay pattern. */}
      {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role, react-doctor/prefer-html-dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg bg-surface-inset border border-primary/20 shadow-2xl font-mono"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="px-3 py-2 border-b border-primary/20 flex items-center gap-2">
          {palette.mode === 'spawn' && <FolderPlus className="size-4 text-active shrink-0" />}
          <input
            ref={palette.inputRef}
            aria-label="Command palette filter"
            type="text"
            value={palette.filter}
            onChange={e => handleChange(e.target.value)}
            onKeyDown={e => palette.handleKeyDown(e, { onSelectConversation: onSelect })}
            placeholder={PLACEHOLDER[palette.mode] ?? PLACEHOLDER_FALLBACK}
            className="w-full bg-transparent text-[19px] sm:text-sm text-foreground placeholder:text-comment outline-none"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>

        {/* Results */}
        <div ref={resultsRef} className="max-h-[40vh] overflow-y-auto">
          <PaletteResults palette={palette} onSelect={onSelect} onClose={onClose} />
        </div>

        <FooterHints
          mode={palette.mode}
          sentinelConnected={palette.sentinelConnected}
          onPrefixTap={prefix => {
            palette.setFilter(prefix)
            palette.setActiveIndex(0)
            palette.inputRef.current?.focus()
          }}
        />
      </div>
    </div>
  )
}
