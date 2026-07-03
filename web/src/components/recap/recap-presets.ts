/**
 * Refinement-instruction presets for the recap Regenerate modal.
 *
 * Two tiers: BUILT-IN starters (curated, always present) and user-saved presets
 * (persisted in localStorage -- per-browser, NOT synced across devices; a broker
 * store is the follow-up when cross-device sync is wanted). A preset is just a
 * named blob of instruction text the user drops into the instructions box.
 */

export interface RecapPreset {
  id: string
  label: string
  instructions: string
  /** True for the curated starters (not user-editable/deletable). */
  builtin?: boolean
}

const BUILTIN_PRESETS: RecapPreset[] = [
  {
    id: 'concise',
    label: 'Concise',
    instructions: 'Keep it tight: one short paragraph per theme, lead with the outcome, cut throat-clearing.',
    builtin: true,
  },
  {
    id: 'exec',
    label: 'Exec summary',
    instructions:
      'Write for a busy executive: top-line outcomes and decisions first, skip implementation detail, no jargon.',
    builtin: true,
  },
  {
    id: 'technical',
    label: 'Technical deep-dive',
    instructions:
      'Write for engineers: keep the technical detail, name the systems and trade-offs, call out risks and follow-ups.',
    builtin: true,
  },
  {
    id: 'client-safe',
    label: 'Client-safe',
    instructions:
      'Safe to share with a client: drop internal frustrations and blame, reframe harsh language, keep it constructive.',
    builtin: true,
  },
  {
    id: 'upbeat',
    label: 'Upbeat',
    instructions: 'Keep the tone positive and momentum-focused; celebrate the shipping wins without inventing any.',
    builtin: true,
  },
]

const LS_KEY = 'rclaude.recapPresets.v1'

function readStore(): RecapPreset[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is RecapPreset =>
        p && typeof p.id === 'string' && typeof p.label === 'string' && typeof p.instructions === 'string',
    )
  } catch {
    return []
  }
}

function writeStore(presets: RecapPreset[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(presets))
  } catch {
    // Quota / disabled storage -- non-fatal; presets just won't persist.
  }
}

/** All presets for the picker: curated starters then the user's own (newest
 *  first, as stored). */
export function allPresets(): RecapPreset[] {
  return [...BUILTIN_PRESETS, ...readStore()]
}

/** Save (or rename-in-place by label) a user preset; returns the stored record.
 *  A blank label or instructions is rejected (returns null). */
export function saveUserPreset(label: string, instructions: string): RecapPreset | null {
  const name = label.trim()
  const text = instructions.trim()
  if (!name || !text) return null
  const existing = readStore()
  const match = existing.find(p => p.label.toLowerCase() === name.toLowerCase())
  if (match) {
    match.instructions = text
    writeStore(existing)
    return match
  }
  const preset: RecapPreset = { id: crypto.randomUUID(), label: name, instructions: text }
  writeStore([preset, ...existing])
  return preset
}

export function deleteUserPreset(id: string): void {
  writeStore(readStore().filter(p => p.id !== id))
}
