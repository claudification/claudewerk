import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Small hover-revealed copy affordance. Render it inside a `group` container:
 * it stays invisible until that group is hovered, then flips to a check for a
 * beat once the text is on the clipboard.
 */
export function CopyIconButton({
  text,
  title = 'Copy',
  className,
}: {
  text: string
  title?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation()
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {}) // insecure context / permission denied -- nothing useful to show
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={title}
      aria-label={title}
      className={cn(
        'shrink-0 p-0.5 rounded transition-all',
        copied ? 'text-emerald-400' : 'text-muted-foreground/0 group-hover:text-fg-dim hover:!text-foreground',
        className,
      )}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}
