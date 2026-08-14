/**
 * THE DOCTOR, DRIVEN OFF THE KEY REGISTRY. Two questions, both answered from
 * `card-schema.ts` rather than from anything written down here:
 *
 *   - is a key the board NEEDS absent?     -> `spec.required`
 *   - does a key it KNOWS hold a value it cannot use? -> `cardValueProblem`
 *
 * OPEN, and this is where that promise gets kept or broken. A key with no spec
 * produces NOTHING -- not a warning, not an info line, not a "did you mean". The
 * DONE-gate machine-authors `evidence_*`, agents invent keys, and a check that
 * nags about either gets switched off within a day, taking the checks that earn
 * their keep down with it. The registry describes what is KNOWN, not what is
 * ALLOWED, and this pass is the proof.
 *
 * LINKAGE KEYS ARE SKIPPED. `project-doctor-linkage.ts` already checks their
 * arity, their aliases, their deprecation and whether their targets exist. Two
 * passes reporting one root cause is how a report becomes a wall.
 *
 * The check ids come from the registry, not from this file, because
 * `card-status-missing` / `card-status-invalid` / `card-title-missing` shipped
 * before it existed and are greppable in CLI output and tests alike.
 */

import { type CardKeyFinding, type CardKeySpec, cardKeySpec, REQUIRED_CARD_KEYS } from './card-schema'
import { cardValueProblem, isEmptyCardValue } from './card-schema-validate'
import type { DoctorFinding } from './project-doctor-types'

export interface SchemaCardSource {
  id: string
  /** Raw frontmatter exactly as parsed -- shapes matter here, so this must NOT
   *  be a projected card: projection has already applied the very defaults
   *  (missing lane -> `inbox`) that are the thing being checked. */
  meta: Record<string, unknown>
  /** Lane directory a legacy card was found in, when that is its only status
   *  record. */
  laneStatus?: string
}

/**
 * Keys whose ABSENCE another pass owns. `created` is repaired outright by
 * project-doctor-created.ts, and a doctor that both stamps a value and files an
 * info line about it having been missing is reporting one fact twice.
 */
const MISSING_REPORTED_ELSEWHERE = new Set(['created'])

/** Fallback for a key that declares no `invalid` of its own. */
const TYPE_CHECK: CardKeyFinding = { check: 'card-key-type', severity: 'warning' }

/**
 * A legacy-lane card gets its status from the directory it still lives in, so a
 * missing `status:` is not brokenness -- it is an undrained card, which
 * `legacy-lane-cards` already reports.
 */
function suppressed(spec: CardKeySpec, source: SchemaCardSource): boolean {
  return spec.key === 'status' && Boolean(source.laneStatus)
}

function missingFindings(source: SchemaCardSource): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  for (const spec of REQUIRED_CARD_KEYS) {
    if (MISSING_REPORTED_ELSEWHERE.has(spec.key)) continue
    if (!isEmptyCardValue(source.meta[spec.key])) continue
    if (suppressed(spec, source)) continue
    const required = spec.required
    if (!required) continue
    findings.push({
      check: required.check,
      severity: required.severity,
      subject: source.id,
      problem: `no \`${spec.key}:\` -- ${spec.consequence ?? spec.doc}`,
      remedy: required.remedy ?? `add a \`${spec.key}:\` line -- ${spec.doc}`,
    })
  }
  return findings
}

function typeFindings(source: SchemaCardSource): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  for (const [key, value] of Object.entries(source.meta)) {
    const spec = cardKeySpec(key)
    // No spec = not our business (OPEN). Linkage = somebody else's business.
    if (!spec || spec.linkage) continue
    const problem = cardValueProblem(spec, value)
    if (!problem) continue
    const report = spec.invalid ?? TYPE_CHECK
    findings.push({
      check: report.check,
      severity: report.severity,
      subject: source.id,
      problem: problem.problem,
      remedy: report.remedy ?? problem.remedy,
    })
  }
  return findings
}

/** Every registry-level problem on one card. */
export function checkCardSchema(source: SchemaCardSource): DoctorFinding[] {
  return [...missingFindings(source), ...typeFindings(source)]
}
