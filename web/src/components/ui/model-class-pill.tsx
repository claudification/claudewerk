/**
 * Model-class pill, shared by the conversation list and the transcript's
 * Agent tool rows.
 *
 * Renders the model CLASS (Opus / Sonnet / Haiku / Fable / Mythos) for a
 * conversation as a subtle tinted pill, derived from the raw model id on
 * `Conversation.model` (e.g. `claude-opus-4-8[1m]` -> "Opus").
 *
 * The class is resolved through `resolveModelFamily` (the single source of
 * truth in `@shared/models`), then reduced to the leading word of the family's
 * `displayName` ("Opus 4.8" -> "Opus"). Each class gets a hue chosen to read as
 * an at-a-glance signal without shouting: colored text over a faint tint and a
 * low-opacity border. Unknown / unresolvable models fall back to a neutral
 * muted pill so the row never renders garbage.
 */

import { resolveModelFamily } from '@shared/models'
import { cn } from '@/lib/utils'

/** Tailwind classes per model class -- text + faint tint + low-opacity border. */
const MODEL_PILL: Record<string, string> = {
  // Anthropic's terracotta; the top tier earns the warmest accent.
  opus: 'text-amber-400 bg-amber-400/15 border-amber-400/30',
  // The calm, steady workhorse.
  sonnet: 'text-sky-400 bg-sky-400/15 border-sky-400/30',
  // Fast and light -- a "go" green.
  haiku: 'text-emerald-400 bg-emerald-400/15 border-emerald-400/30',
  // Storytelling / imaginative.
  fable: 'text-violet-400 bg-violet-400/15 border-violet-400/30',
  // Epic / legendary -- a warm standout.
  mythos: 'text-rose-400 bg-rose-400/15 border-rose-400/30',
}

const NEUTRAL_PILL = 'text-muted-foreground bg-muted border-primary/20'

/**
 * Resolve a raw model id to its display class + tint key.
 * Returns null when there's no model or it can't be reduced to a label.
 */
function resolveModelClass(model: string): { label: string; key: string } | null {
  const family = resolveModelFamily(model)
  // displayName is "Opus 4.8" / "Fable 5" / "Sonnet 4.6" -- the class is word 1.
  const label = (family?.displayName.split(' ')[0] ?? '').trim()
  if (!label) return null
  return { label, key: label.toLowerCase() }
}

export function ModelClassPill({ model, className }: { model?: string; className?: string }) {
  if (!model) return null
  const resolved = resolveModelClass(model)
  if (!resolved) return null
  return (
    <span
      className={cn(
        'inline-flex items-center px-1 py-0.5 text-[8px] rounded border font-medium',
        MODEL_PILL[resolved.key] ?? NEUTRAL_PILL,
        className,
      )}
      title={`Model: ${model}`}
    >
      {resolved.label}
    </span>
  )
}
