/**
 * Cheap, dependency-free token estimate for budget decisions (sizing the
 * protected tail) -- NOT for billing. ~4 chars/token is the common English
 * heuristic and is plenty accurate to decide what fits under a budget.
 */
export type TokenEstimator = (text: string) => number

export const estimateTokens: TokenEstimator = text => Math.ceil(text.length / 4)
