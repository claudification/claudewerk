/**
 * voice-keyterms - the vocabulary this app is dictated IN, plus whatever the
 * active project adds.
 *
 * WHY A BUILT-IN LIST. Keyterms measurably work: the same 26s fixture came back
 * with "CloudFlo" bare and "Cloudflare" with keyterms on, at no cost in lag
 * (max 358ms -> 133ms). But per-project keyterms are opt-in and mostly empty,
 * so nobody got that fix by default. These nouns are the same in EVERY project
 * because they are the tool's own vocabulary, not any one repo's.
 *
 * THE LIST IS SHORT BECAUSE A LONG ONE MEASURABLY STOPS WORKING. Same fixture,
 * same audio, same target word, six runs:
 *
 *    0 terms -> "CloudFlo"      4 terms -> "Cloudflare"  (twice)
 *    6 terms -> "Cloudflare"   10 terms -> "CloudFlo"
 *                              25 terms -> "CloudFlo"
 *
 * Adding terms the speaker never says does not cost nothing -- it dilutes the
 * bias until the fix disappears. The first version of this file was a 25-noun
 * "vocabulary list" and it performed exactly as badly as sending none at all.
 *
 * So: proper nouns and jargon ONLY, and only the ones actually said out loud.
 * Not ordinary English -- "broker", "transcript" and "endpoint" already come
 * back correct and would each burn a slot. If you add one, run the probe and
 * check the fix survives; the cliff sits between 6 and 10 and has not been
 * measured more finely than that (one fixture, one target word).
 */

import { projectIdentityKey } from '@shared/project-uri'

/**
 * THREE. Every one of them earns its slot.
 *
 * The list was six, and the trim came from reading the ZERO-keyterm transcript
 * properly: "sentinel", "agent host", "control panel" and "Deepgram" all came
 * back correct unaided. They were not helping, they were spending bias on words
 * flux already knows -- which, per the header, is exactly how the list stops
 * working. "Cloudflare" is the only word the probe has ever caught it missing.
 */
const BUILT_IN_KEYTERMS: readonly string[] = [
  // Measured: "CloudFlo" unaided, "Cloudflare" with this on.
  'Cloudflare',
  // Said in nearly every sentence here, and a name rather than a word.
  'Claude',
  // No general model has heard of it.
  'claudewerk',
]

/**
 * Built-ins plus the active project's own terms, de-duplicated case-insensitively
 * so a project repeating "Cloudflare" does not spend two slots on it. Project
 * terms come FIRST: they are the specific ones, and if the cap ever bites, the
 * generic built-ins are the right thing to lose.
 */
export function resolveKeyterms(projectTerms: readonly string[] = []): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const term of [...projectTerms, ...BUILT_IN_KEYTERMS]) {
    const clean = term.trim()
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

/** The project's configured keyterms, or nothing. Never throws: a missing
 *  project or an unconfigured one is the normal case, not an error. */
export function projectKeyterms(
  project: string | undefined,
  settings: Record<string, { keyterms?: string[] } | undefined>,
): string[] {
  if (!project) return []
  return settings[projectIdentityKey(project)]?.keyterms ?? []
}
