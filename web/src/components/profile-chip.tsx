/**
 * The tinted letter chip that identifies a sentinel profile -- `[A]`, `[B]`.
 *
 * Pure presentation: it takes an already-resolved label + color and renders
 * them. Every surface that shows "which profile is this" uses THIS chip, so
 * the conversation list, the sidebar rail and the usage popover stay visually
 * identical instead of each hand-rolling a span.
 *
 * PROFILE-ENV BOUNDARY: display metadata only (label / color) -- never
 * configDir or env.
 */

import { Shuffle } from 'lucide-react'

interface ProfileChipProps {
  /** Visible text -- the operator's `label` (e.g. `A`) or the profile name. */
  label: string
  /** Tint from the profile's `color`. Falls back to the muted chip styling. */
  color?: string
  /** Native tooltip text. */
  title: string
  /** Render the pool "shuffle" hint before the label. */
  shuffle?: boolean
}

export function ProfileChip({ label, color, title, shuffle }: ProfileChipProps) {
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0.5 text-[8px] rounded border border-primary/20 bg-muted text-muted-foreground font-medium"
      style={color ? { color, borderColor: color } : undefined}
      title={title}
    >
      {shuffle && <Shuffle className="size-2.5" />}
      {label}
    </span>
  )
}
