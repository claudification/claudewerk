/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { detectReportArtifactRelPath } from './report-artifact'

describe('detectReportArtifactRelPath', () => {
  it('extracts the configDir-relative path from a /insights payload (.claude-work)', () => {
    const content = `At a glance...\nReport URL: file:///Users/jonas/.claude-work/usage-data/report-2026-06-07-131009.html\nHTML file: /Users/jonas/.claude-work/usage-data/report-2026-06-07-131009.html`
    expect(detectReportArtifactRelPath(content)).toBe('usage-data/report-2026-06-07-131009.html')
  })

  it('works for the default .claude profile path too', () => {
    const content = 'Report URL: file:///Users/jonas/.claude/usage-data/report-2026-01-02-030405.html'
    expect(detectReportArtifactRelPath(content)).toBe('usage-data/report-2026-01-02-030405.html')
  })

  it('returns undefined when no report path is present', () => {
    expect(detectReportArtifactRelPath('# Some skill body\nno report here')).toBeUndefined()
  })

  it('returns undefined for a non-report usage-data file', () => {
    expect(detectReportArtifactRelPath('see usage-data/facets/hour.json')).toBeUndefined()
  })
})
