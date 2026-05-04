import { type ReactNode, useState } from 'react'
import { haptic } from '@/lib/utils'

function InlineConfirmButton({
  onConfirm,
  confirmLabel,
  trigger,
}: {
  onConfirm: () => void
  confirmLabel?: ReactNode
  trigger: (requestConfirm: (e: React.MouseEvent | React.KeyboardEvent) => void) => ReactNode
}) {
  const [confirming, setConfirming] = useState(false)

  function handleConfirm() {
    haptic('tap')
    onConfirm()
    setConfirming(false)
  }

  if (confirming) {
    return (
      <div
        className="flex items-center gap-1 text-[9px]"
        role="group"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        {confirmLabel}
        <div
          role="button"
          tabIndex={0}
          onClick={handleConfirm}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') handleConfirm()
          }}
          className="text-destructive hover:text-destructive/80 cursor-pointer font-bold"
        >
          yes
        </div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setConfirming(false)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') setConfirming(false)
          }}
          className="text-muted-foreground hover:text-foreground cursor-pointer"
        >
          no
        </div>
      </div>
    )
  }

  function requestConfirm(e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation()
    haptic('tap')
    setConfirming(true)
  }

  return <>{trigger(requestConfirm)}</>
}

export { InlineConfirmButton }
