/**
 * The panel for a preview whose caller already had every answer.
 *
 * Same frame as the card hover -- a preview that changed width, padding or
 * corner radius depending on which row you were over would read as a glitch, and
 * reusing `HoverFrame`/`HoverSection` is what makes that true by construction
 * rather than by two stylesheets agreeing.
 */

import { HoverFrame, HoverSection } from './card-hover-parts'
import { type HoverFacts, liveFacts } from './hover-facts'

export function HoverFactsPanel({ facts }: { facts: HoverFacts }) {
  const rows = liveFacts(facts.facts)

  return (
    <HoverFrame>
      <HoverSection className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground shrink-0">
          {facts.kicker}
        </span>
        <span className="text-foreground leading-snug break-words min-w-0">{facts.title}</span>
      </HoverSection>

      {rows.length > 0 && (
        <HoverSection>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
                <dd className="font-mono text-[11px] text-foreground/90 break-words">{value}</dd>
              </div>
            ))}
          </dl>
        </HoverSection>
      )}

      {/* IN FULL, and wrapped. The row truncated this to fit a column; the whole
          point of the preview is to be the place it is not truncated. */}
      {facts.body && (
        <HoverSection className="text-foreground/90 leading-snug whitespace-pre-wrap break-words">
          {facts.body}
        </HoverSection>
      )}

      {facts.footer && (
        <HoverSection className="font-mono text-[10px] text-muted-foreground truncate">{facts.footer}</HoverSection>
      )}
    </HoverFrame>
  )
}
