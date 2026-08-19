/**
 * The hover-revealed copy affordance on an S1 row.
 *
 * LOCAL ON PURPOSE, AND TEMPORARY. `wall-copy-affordance` owns the universal
 * version -- every pane copies a report, every row copies itself -- and has not
 * landed. This card asks for the button on this row, so the button is here,
 * deliberately small and with no API of its own, so that card can delete the
 * file and swap the import rather than untangle a second implementation.
 *
 * It stays in the DOM at all times (opacity, not conditional rendering) so
 * keyboard focus can reach it on a row nobody is hovering.
 */

import { useState } from 'react'
import { cn } from '@/lib/utils'

export function VitalsCopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    // No clipboard (insecure origin, old WebView): say nothing rather than claim
    // a copy that did not happen.
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      },
      () => setCopied(false),
    )
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={label}
      className={cn(
        'shrink-0 px-1 leading-none rounded-[2px] border border-transparent',
        'text-fg-faint hover:text-foreground hover:border-border',
        'opacity-0 group-hover/host:opacity-100 focus-visible:opacity-100',
        copied && 'opacity-100 text-success',
      )}
      style={{ fontSize: 9 }}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  )
}
