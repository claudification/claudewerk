import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { formatKeyCode } from './key-capture-format'

// Disallowed: keys that conflict with normal usage
const DISALLOWED_KEYS = new Set(['Escape', 'Tab', 'Enter', 'Backspace', 'Delete'])

export function KeyCapture({ value, onChange }: { value: string | null; onChange: (code: string | null) => void }) {
  const [capturing, setCapturing] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleCapture = useCallback(() => setCapturing(true), [])

  useEffect(() => {
    if (!capturing) return

    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setCapturing(false)
        return
      }
      if (DISALLOWED_KEYS.has(e.code)) return
      onChange(e.code)
      setCapturing(false)
    }

    function handleClickOutside(e: MouseEvent) {
      if (!buttonRef.current?.contains(e.target as Node)) setCapturing(false)
    }

    // Small delay so the click that opened capture doesn't immediately fire
    const t = setTimeout(() => {
      window.addEventListener('keydown', handleKeyDown, { capture: true })
      window.addEventListener('mousedown', handleClickOutside)
    }, 100)

    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('mousedown', handleClickOutside)
    }
  }, [capturing, onChange])

  return (
    <div className="flex items-center gap-2">
      <button
        ref={buttonRef}
        type="button"
        onClick={capturing ? () => setCapturing(false) : handleCapture}
        className={cn(
          'px-3 py-1 text-xs font-mono border rounded transition-all min-w-[100px] text-center',
          capturing
            ? 'border-blue-500 bg-blue-500/20 text-blue-400 animate-pulse'
            : value
              ? 'border-border bg-muted text-foreground'
              : 'border-border bg-muted/50 text-muted-foreground',
        )}
      >
        {capturing ? 'Press a key...' : value ? formatKeyCode(value) : 'Not set'}
      </button>
      {value && !capturing && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[10px] text-muted-foreground hover:text-destructive"
        >
          clear
        </button>
      )}
    </div>
  )
}
