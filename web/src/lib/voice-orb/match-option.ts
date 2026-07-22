/**
 * Turning a SPOKEN answer into one of the options actually on offer.
 *
 * Same discipline as resolve-conversation.ts, for the same reason: speech loses
 * punctuation and case, so matching is loose -- but a TIE or a miss REFUSES and
 * hands the options back, because submitting the wrong answer to a blocked
 * agent is worse than asking again. Nothing here submits; it only decides.
 *
 * People also answer positionally ("the second one", "number three"), which no
 * amount of label matching would catch, so a purely positional phrase is
 * resolved by index before any text scoring.
 */

import type { VoiceOption } from './dialog-answerable'
import { rankSpoken } from './rank-spoken'

export type OptionMatch = { ok: true; option: VoiceOption } | { ok: false; error: string; options: VoiceOption[] }

/** Filler around the actual answer: "let's go with rollback, please". */
const LEAD = /^(?:ok(?:ay)?|yeah|yes|well|so|um+|uh+)[,\s]+/i
const PICK = /^(?:i(?:'| a)?ll\s+|let'?s\s+|we'?ll\s+)?(?:take|pick|choose|select|go\s+with|answer|say|do)\s+/i
const TRAIL = /[\s,.!?]+$/
const ARTICLE = /^(?:the|that|a|an)\s+/i

/** Strip the politeness so "let's go with the rollback, please" is "rollback". */
export function cleanSpoken(spoken: string): string {
  let s = spoken.trim().replace(TRAIL, '')
  for (const re of [LEAD, PICK, ARTICLE]) s = s.replace(re, '').trim()
  s = s.replace(/\s+please$/i, '').replace(TRAIL, '')
  return s.trim()
}

const WORD_ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
}

/** A phrase that is ONLY a position: "the second one", "option 3", "number two",
 *  "the last one". Anything with extra words is left to text matching. */
const POSITIONAL = /^(?:option|choice|number|answer)?\s*([a-z0-9]+)(?:\s+(?:one|option|choice))?$/i

function digits(token: string): number {
  return /^\d+$/.test(token) ? Number.parseInt(token, 10) : 0
}

/** 1-based position a purely positional phrase names, or 0. */
function spokenPosition(cleaned: string, count: number): number {
  const token = POSITIONAL.exec(cleaned.toLowerCase().trim())?.[1]
  if (!token) return 0
  if (token === 'last') return count
  const n = WORD_ORDINALS[token] ?? digits(token)
  return n >= 1 && n <= count ? n : 0
}

/** Punctuation- and space-free form, for "auto deploy" vs "auto-deploy". */
function loose(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** He said the option, give or take the punctuation. */
function exactScore(option: VoiceOption, needle: string, nLoose: string): number {
  if (option.value.toLowerCase() === needle || option.label.toLowerCase() === needle) return 100
  if (loose(option.label) === nLoose || loose(option.value) === nLoose) return 90
  return 0
}

/** He said something LIKE the option -- good enough to win, never good enough
 *  to beat a tie. A short utterance ("no") must not match a long description. */
function fuzzyScore(option: VoiceOption, needle: string, nLoose: string): number {
  const label = option.label.toLowerCase()
  if (label.startsWith(needle)) return 75
  if (label.includes(needle)) return 70
  if (loose(label).includes(nLoose)) return 60
  if (nLoose.length >= 4 && (option.description ?? '').toLowerCase().includes(needle)) return 40
  return 0
}

/** Rank one option against the cleaned spoken answer. 0 = no match. */
function score(option: VoiceOption, needle: string): number {
  const nLoose = loose(needle)
  if (!nLoose) return 0
  return exactScore(option, needle, nLoose) || fuzzyScore(option, needle, nLoose)
}

/** An exact-ish score: the user said the option, not something like it. */
const EXACT = 90

/**
 * Which option the user meant. Refuses on a miss OR a tie -- both come back with
 * the options so the caller can have the orb ask again.
 *
 * Naming an option beats counting to it (an option literally labelled "Two" is
 * what "two" means), and both beat a loose substring.
 */
export function matchSpokenOption(spoken: string, options: VoiceOption[]): OptionMatch {
  const cleaned = cleanSpoken(typeof spoken === 'string' ? spoken : '')
  if (!cleaned) return { ok: false, error: 'no answer heard', options }

  const needle = cleaned.toLowerCase()
  const { ranked, winner, tied, topScore } = rankSpoken(options, option => score(option, needle))
  if (winner && topScore >= EXACT) return { ok: true, option: winner }

  const position = spokenPosition(cleaned, options.length)
  const byPosition = position > 0 ? options[position - 1] : undefined
  if (byPosition) return { ok: true, option: byPosition }

  if (winner) return { ok: true, option: winner }
  if (tied) return { ok: false, error: `"${spoken}" could be either -- ask which`, options: ranked }
  return { ok: false, error: `"${spoken}" is not one of the options`, options }
}
