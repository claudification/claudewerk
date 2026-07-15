/**
 * SOTU enrichment render tests (Phase 6) -- proves the per-project strip surfaces
 * the narrative + git alerts + the genuinely-visible CONTENDED pill + per-branch
 * merge-risk, and that the fleet stats fold the union (incl. the hidden-projects
 * note). HARD RULE 9 backstop for the render path.
 */

import type { BranchFabric, SheafFleetSotu, SheafProjectSotu } from '@shared/sheaf-types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { FleetSotuStats, SotuProjectStrip } from './sheaf-sotu'

afterEach(cleanup)

function branch(over: Partial<BranchFabric> = {}): BranchFabric {
  return {
    branch: 'feature-x',
    aheadOrigin: 0,
    behindOrigin: 0,
    aheadLocal: 0,
    behindLocal: 0,
    integration: 'merge-clean',
    alerts: [],
    ...over,
  }
}

function projectSotu(over: Partial<SheafProjectSotu> = {}): SheafProjectSotu {
  return { enabled: true, alerts: [], contended: 0, branches: [], ...over }
}

describe('SotuProjectStrip', () => {
  test('renders narrative + AT-RISK/UNPUSHED alert chips + CONTENDED pill', () => {
    render(
      <SotuProjectStrip
        sotu={projectSotu({
          narrative: 'Alpha is mid-refactor of permissions.',
          alerts: ['at-risk', 'unpushed'],
          contended: 2,
        })}
      />,
    )
    expect(screen.getByText('Alpha is mid-refactor of permissions.')).toBeTruthy()
    expect(screen.getByText('AT-RISK')).toBeTruthy()
    expect(screen.getByText('UNPUSHED')).toBeTruthy()
    expect(screen.getByText(/2 CONTENDED/)).toBeTruthy()
  })

  test('renders per-branch merge-risk: conflicts loud, ahead/behind counts', () => {
    render(
      <SotuProjectStrip
        sotu={projectSotu({
          branches: [
            branch({ branch: 'feat-a', integration: 'conflicts', conflictFiles: ['x.ts'] }),
            branch({ branch: 'feat-b', aheadOrigin: 3, behindOrigin: 1 }),
          ],
        })}
      />,
    )
    expect(screen.getByText(/feat-a/)).toBeTruthy()
    expect(screen.getByText(/conflicts/)).toBeTruthy()
    expect(screen.getByText(/feat-b/)).toBeTruthy()
  })

  test('shows grounding chip + flags ungrounded citations', () => {
    render(
      <SotuProjectStrip
        sotu={projectSotu({
          grounding: { precision: 0.5, coverage: 1, citedConvs: 2, knownConvs: 1, unknownCited: 1 },
        })}
      />,
    )
    expect(screen.getByText(/grounded 50%/)).toBeTruthy()
    expect(screen.getByText(/1 ungrounded/)).toBeTruthy()
  })

  test('renders nothing when there is nothing to say', () => {
    const { container } = render(<SotuProjectStrip sotu={projectSotu()} />)
    expect(container.firstChild).toBeNull()
  })

  test('renders nothing for a hidden project (no sotu block)', () => {
    const { container } = render(<SotuProjectStrip sotu={undefined} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('FleetSotuStats', () => {
  test('folds the union: contended + alerts + hidden-projects note', () => {
    const sotu: SheafFleetSotu = {
      projectsEnabled: 2,
      projectsWithNarrative: 1,
      alerts: ['at-risk', 'stalled'],
      contended: 3,
      atRiskProjects: 1,
      unpushedProjects: 0,
      stalledProjects: 1,
      unmergedProjects: 0,
      filteredProjects: 2,
    }
    render(<FleetSotuStats sotu={sotu} />)
    expect(screen.getByText(/3 CONTENDED/)).toBeTruthy()
    expect(screen.getByText('AT-RISK')).toBeTruthy()
    expect(screen.getByText('STALLED')).toBeTruthy()
    expect(screen.getByText(/2 hidden/)).toBeTruthy()
  })

  test('renders nothing when the union is empty', () => {
    const sotu: SheafFleetSotu = {
      projectsEnabled: 0,
      projectsWithNarrative: 0,
      alerts: [],
      contended: 0,
      atRiskProjects: 0,
      unpushedProjects: 0,
      stalledProjects: 0,
      unmergedProjects: 0,
      filteredProjects: 0,
    }
    const { container } = render(<FleetSotuStats sotu={sotu} />)
    expect(container.firstChild).toBeNull()
  })
})
