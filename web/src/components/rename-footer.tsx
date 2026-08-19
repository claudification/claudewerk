import { Button } from './ui/button'
import { Kbd } from './ui/kbd'

interface RenameFooterProps {
  onSubmit: () => void
}

/** Bottom bar of the rename modal: key hints + the Save button. */
export function RenameFooter({ onSubmit }: RenameFooterProps) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-border shrink-0">
      <span className="text-[10px] text-muted-foreground flex items-center gap-1.5">
        <Kbd>Enter</Kbd> save
        <span className="text-fg-faint">·</span>
        <Kbd>Esc</Kbd> cancel
      </span>
      <Button type="button" variant="accent" size="sm" onClick={onSubmit}>
        Save
        <Kbd className="border-accent-foreground/25 bg-accent-foreground/15 text-accent-foreground">Enter</Kbd>
      </Button>
    </div>
  )
}
