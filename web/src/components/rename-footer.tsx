import { Kbd } from './ui/kbd'

interface RenameFooterProps {
  showSuggestion: boolean
  requestingName: boolean
  showFetchHint: boolean
  onSubmit: () => void
}

/** Bottom bar of the rename modal: key hints + the Save button. The Ctrl+Shift+R
 *  hint adapts: accept the suggestion when one's on offer, otherwise fetch one
 *  (and show a spinner while that background recap is in flight). */
export function RenameFooter({ showSuggestion, requestingName, showFetchHint, onSubmit }: RenameFooterProps) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-border shrink-0">
      <span className="text-[10px] text-muted-foreground flex items-center gap-1.5">
        <Kbd>Enter</Kbd> save
        {requestingName ? (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-accent/80 animate-pulse">suggesting name...</span>
          </>
        ) : showSuggestion ? (
          <>
            <span className="text-muted-foreground/40">·</span>
            <Kbd>Ctrl+Shift+R</Kbd> accept suggestion
          </>
        ) : showFetchHint ? (
          <>
            <span className="text-muted-foreground/40">·</span>
            <Kbd>Ctrl+Shift+R</Kbd> suggest a name
          </>
        ) : null}
        <span className="text-muted-foreground/40">·</span>
        <Kbd>Esc</Kbd> cancel
      </span>
      <button
        type="button"
        onClick={onSubmit}
        className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
      >
        Save
        <Kbd className="bg-accent/20 text-accent/70">Enter</Kbd>
      </button>
    </div>
  )
}
