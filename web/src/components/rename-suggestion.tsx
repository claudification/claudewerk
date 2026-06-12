import { Sparkles } from 'lucide-react'

interface RenameSuggestionProps {
  suggestion: string
  onApply: () => void
}

/** Tappable chip offering the recap-suggested conversation name. Sits below the
 *  NAME field and is purely additive -- it fills the input only when clicked, so
 *  the current name is never clobbered silently. Shown only when a suggestion
 *  exists and differs from what's already in the field. */
export function RenameSuggestion({ suggestion, onApply }: RenameSuggestionProps) {
  return (
    <button
      type="button"
      onClick={onApply}
      title="Use the suggested name"
      className="group -mt-1 flex max-w-full items-center gap-1.5 self-start border border-dashed border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-accent"
    >
      <Sparkles className="size-3 shrink-0 text-accent/70 group-hover:text-accent" />
      <span className="text-muted-foreground/60 group-hover:text-accent/70">suggested</span>
      <span className="truncate text-foreground group-hover:text-accent">{suggestion}</span>
    </button>
  )
}
