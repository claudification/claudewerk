/**
 * What PROJECT DOCTOR reports. One finding shape for every check, so the CLI
 * renders them uniformly and a future MCP tool or panel view can consume the
 * same structure without a second vocabulary.
 *
 * EVERY FINDING CARRIES A REMEDY. A health check that tells you something is
 * wrong and leaves you to work out what to do about it is half a tool -- the
 * remedy line is not decoration, it is the deliverable.
 */

/** `error` = the board is lying to you; `warning` = rot; `info` = worth knowing. */
export type DoctorSeverity = 'error' | 'warning' | 'info'

export const SEVERITY_ORDER: Record<DoctorSeverity, number> = { error: 0, warning: 1, info: 2 }

export interface DoctorFinding {
  /** Stable kebab-case check id -- greppable, and safe to key remedies on. */
  check: string
  severity: DoctorSeverity
  /** Card id, or a board-relative path when the subject is not a card. */
  subject: string
  /** What is wrong, one line. */
  problem: string
  /** What to do about it, one line. A command when one exists. */
  remedy: string
}

export interface DoctorReport {
  /** Absolute path of `<root>/.rclaude/project`. */
  board: string
  /** True when there is no board here at all -- not a failure, just nothing. */
  noBoard: boolean
  /** Cards read, canonical + any still in legacy lanes. */
  cards: number
  findings: DoctorFinding[]
}

export function countBySeverity(findings: DoctorFinding[]): Record<DoctorSeverity, number> {
  const counts: Record<DoctorSeverity, number> = { error: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  return counts
}

/** Errors first, then by check, then by subject -- stable output run to run. */
export function sortFindings(findings: DoctorFinding[]): DoctorFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.check.localeCompare(b.check) ||
      a.subject.localeCompare(b.subject),
  )
}
