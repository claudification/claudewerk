/**
 * TranscriptDropZone - Drag-and-drop overlay for the transcript area.
 * Wraps children and intercepts file drops, dispatching them to the input bar
 * via a custom 'file-upload-request' event.
 *
 * Only renders the drop target when enabled (permission-gated by parent).
 */

import { useCallback, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface TranscriptDropZoneProps {
  enabled: boolean
  children: React.ReactNode
  className?: string
}

export function TranscriptDropZone({ enabled, children, className }: TranscriptDropZoneProps) {
  const [dragOver, setDragOver] = useState(false)
  const dragCountRef = useRef(0)

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!enabled) return
      e.preventDefault()
      dragCountRef.current++
      if (dragCountRef.current === 1) setDragOver(true)
    },
    [enabled],
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCountRef.current--
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!enabled) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    [enabled],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragCountRef.current = 0
      setDragOver(false)
      if (!enabled) return
      const files = e.dataTransfer?.files
      if (!files?.length) return
      for (const file of files) {
        window.dispatchEvent(new CustomEvent('file-upload-request', { detail: file }))
      }
    },
    [enabled],
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop zone container, drag events are not keyboard-accessible by nature
    <div
      className={cn('relative', className)}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {dragOver && enabled && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-accent/10 border-2 border-dashed border-accent rounded-lg pointer-events-none backdrop-blur-[1px]">
          <div className="text-accent font-mono text-sm font-bold px-4 py-2 bg-background/80 rounded">
            Drop to attach
          </div>
        </div>
      )}
    </div>
  )
}
