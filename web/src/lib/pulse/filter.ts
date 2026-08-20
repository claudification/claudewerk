/**
 * Barrel for the Pulse filter grammar. The grammar itself is documented on
 * `PulseQuery` in `query-types.ts`; parsing lives in `query-parse.ts` and
 * matching in `query-match.ts`.
 *
 * Only what callers outside this folder actually need is re-exported —
 * tokenizing, the empty-query constant and the exclusion shape are internals.
 */
export { highlightRange, isEmptyQuery, localDayKey, matchesPulseQuery } from './query-match'
export { parseDay, parsePulseQuery, parseWindow } from './query-parse'
export type { PulseQuery, PulseSearchable } from './query-types'
