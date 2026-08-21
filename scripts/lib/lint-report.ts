/**
 * Shared pass/fail reporting for the lint scripts.
 *
 * Every lint here ends the same way: print a one-line OK and exit 0, or print
 * `file:line` + a reason per finding, a fix hint, and exit 1. That tail was
 * copy-pasted across scripts until fallow flagged it as a clone group.
 */

export interface LintFinding {
  file: string
  line: number
  /** Why this line is a violation -- printed indented under the location. */
  detail: string
}

/**
 * Print the verdict and exit the process: 0 when `findings` is empty, 1 otherwise.
 * `okLine` is the clean-run summary; `failLine(count)` heads the violation list;
 * `hint` is the closing "how to fix" paragraph (already newline-separated).
 */
export function reportAndExit(
  findings: LintFinding[],
  okLine: string,
  failLine: (count: number) => string,
  hint: string,
): never {
  if (findings.length === 0) {
    console.log(okLine)
    process.exit(0)
  }

  console.error(`\n${failLine(findings.length)}\n`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`)
    console.error(`    ${f.detail}`)
    console.error()
  }
  console.error(`${hint}\n`)
  process.exit(1)
}
