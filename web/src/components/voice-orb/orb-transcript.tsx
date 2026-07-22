/**
 * THE ORB'S TRANSCRIPT -- what was said, plus a box to TYPE into.
 *
 * WHY TYPING EXISTS AT ALL: the persona's own LOSSY rail says transcription
 * mangles precise strings -- ids, paths, URLs, keys -- so the orb has to read
 * every one of them back and wait for a yes. Pasting skips that whole dance.
 * This is the one input where an exact string arrives exact.
 *
 * A DISCLOSURE, NOT A DIALOG: it is a panel toggled by a button, so it needs a
 * button + a region and nothing else. No role="dialog" -- that word is a promise
 * of focus trapping, inert background and focus restore, and a panel that must
 * NOT trap focus (the mic is live and the orb is still listening) has no
 * business making it.
 */

import { X } from 'lucide-react'
import { ChatComposer, usePinToBottom } from '@/components/chat-bits/chat-bits'
import { cn, haptic } from '@/lib/utils'
import type { SpokenLine } from '@/lib/voice-orb/caption-fold'
import { type OrbMenuActions, OrbMenuButton } from './orb-menu'

export interface OrbTranscriptProps {
  lines: SpokenLine[]
  /** Send typed text to the live session. */
  onSend(text: string): void
  onClose(): void
  /** The orb's self-controls, surfaced here as a real button -- the route that
   *  does not depend on discovering a right-click or a long press. */
  menuActions: OrbMenuActions
  /** True while the session is up -- a dead session takes no input. */
  live: boolean
}

/** Who said it. Short, because the label repeats down the whole column. */
function speaker(role: SpokenLine['role']): string {
  return role === 'user' ? 'you' : 'orb'
}

export function OrbTranscript({ lines, onSend, onClose, menuActions, live }: OrbTranscriptProps) {
  const scrollRef = usePinToBottom(lines)

  return (
    <section
      aria-label="Orb transcript"
      className="w-[min(22rem,calc(100vw-2rem))] rounded-md border border-border bg-popover shadow-lg"
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-[10px] text-muted-foreground uppercase">Transcript</span>
        <span className="flex items-center gap-1">
          <OrbMenuButton actions={menuActions} />
          <button
            type="button"
            aria-label="Close the transcript"
            className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </button>
        </span>
      </header>

      <div ref={scrollRef} className="flex max-h-64 flex-col gap-1.5 overflow-y-auto px-3 py-2">
        {lines.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-muted-foreground">
            Nothing said yet. Talk, or type below -- paste anything voice would mangle.
          </p>
        ) : (
          lines.map((line, i) => (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: the log is append-only and the LAST entry is rewritten in place -- position is the stable identity here, and there is no id to key on
              key={`${i}-${line.role}`}
              className={cn('text-[11px] leading-snug', line.role === 'user' ? 'text-foreground' : 'text-accent')}
            >
              <span className="mr-1.5 font-mono text-[10px] text-muted-foreground">{speaker(line.role)}</span>
              {line.text}
              {line.partial ? <span className="ml-0.5 opacity-50">…</span> : null}
            </p>
          ))
        )}
      </div>

      <div className="border-t border-border p-2">
        <ChatComposer
          onSend={onSend}
          disabled={!live}
          autoFocus
          placeholder={live ? 'Type or paste, Enter to send' : 'The orb is not listening'}
        />
      </div>
    </section>
  )
}
