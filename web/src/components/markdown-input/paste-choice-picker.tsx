import type React from 'react'
import { haptic } from '@/lib/utils'

interface PasteChoicePickerProps {
  file: File
  value: string
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  onUploadFile: (file: File) => void
  onDismiss: () => void
}

export function PasteChoicePicker({
  file,
  value,
  textareaRef,
  onChange,
  onUploadFile,
  onDismiss,
}: PasteChoicePickerProps) {
  return (
    <div className="absolute -top-9 left-0 right-0 z-20 flex items-center gap-2 px-2 py-1.5 bg-background border border-border rounded-t shadow-lg">
      <span className="text-[10px] text-muted-foreground font-mono">Paste as:</span>
      <button
        type="button"
        className="text-[10px] font-mono px-2 py-0.5 bg-accent/20 hover:bg-accent/40 text-accent rounded"
        onClick={() => {
          haptic('tap')
          onUploadFile(file)
          onDismiss()
        }}
      >
        Image
      </button>
      <button
        type="button"
        className="text-[10px] font-mono px-2 py-0.5 bg-muted hover:bg-muted/80 text-foreground rounded"
        onClick={() => {
          haptic('tap')
          navigator.clipboard.readText().then(text => {
            if (text && textareaRef.current) {
              const ta = textareaRef.current
              const start = ta.selectionStart
              const end = ta.selectionEnd
              const newVal = value.slice(0, start) + text + value.slice(end)
              onChange(newVal)
            }
          })
          onDismiss()
        }}
      >
        Text
      </button>
      <button
        type="button"
        className="text-[10px] text-muted-foreground hover:text-foreground ml-auto"
        onClick={onDismiss}
      >
        Cancel
      </button>
    </div>
  )
}
