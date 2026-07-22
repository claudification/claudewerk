/**
 * The shape BOTH spoken matchers share: score every candidate, drop the misses,
 * and hand back the winner ONLY if it beat the runner-up outright.
 *
 * Resolving a conversation name and resolving an option are different problems
 * with different scoring, but the refusal rule is the same one and must stay the
 * same one: a tie is not a decision. It lives here so neither matcher can drift
 * into quietly picking the first of two equals.
 */

export interface SpokenRanking<T> {
  /** Candidates that scored at all, best first. */
  ranked: T[]
  /** The winner, or undefined when nothing matched OR the top two tied. */
  winner?: T
  /** The top two scored the same -- caller must ask, not guess. */
  tied: boolean
  /** The best score, so a caller can tell "he said it" from "close enough". */
  topScore: number
}

export function rankSpoken<T>(candidates: T[], score: (candidate: T) => number): SpokenRanking<T> {
  const scored = candidates
    .map(candidate => ({ candidate, s: score(candidate) }))
    .filter(r => r.s > 0)
    .sort((a, b) => b.s - a.s)

  const ranked = scored.map(r => r.candidate)
  const [best, runnerUp] = scored
  const tied = !!best && !!runnerUp && runnerUp.s === best.s
  return { ranked, winner: tied ? undefined : best?.candidate, tied, topScore: best?.s ?? 0 }
}
