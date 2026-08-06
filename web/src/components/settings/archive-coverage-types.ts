export interface CoverageMonth {
  month: string
  hotRows: number
  coldRows: number | null
  archived: boolean
}

export interface CoverageResponse {
  configured: boolean
  archiveDir?: string
  months: CoverageMonth[]
  hotRows: number
  coldRows: number
  gaps: string[]
}

export type CoverageState = 'both' | 'hot' | 'cold' | 'gap'

export const STATE_LABEL: Record<CoverageState, string> = {
  both: 'hot + archived',
  hot: 'hot',
  cold: 'archived',
  gap: 'GAP',
}

/** Keyed on the two booleans that decide it, so there is exactly one place
 *  where "no rows and no archive" becomes a visible gap. */
export function stateOf(m: CoverageMonth): CoverageState {
  if (m.hotRows > 0) return m.archived ? 'both' : 'hot'
  return m.archived ? 'cold' : 'gap'
}

export function archiveCoverageMatches(filter: string): boolean {
  const f = filter.toLowerCase()
  return ['archive', 'transcript', 'coverage', 'retention', 'cold', 'hot', 'storage'].some(
    k => k.includes(f) || f.includes(k),
  )
}
