/**
 * THE 2026-08-20 INCIDENT, broker half.
 *
 * The sentinel captured the cause and put it on the wire. The broker logged
 * `stderrTail=1` -- the COUNT -- and dropped the line, so the only record of why
 * a verifier died in 1.2s was a file inside the project the broker never reads:
 *
 *   ERR Error creating worktree: Invalid worktree name: must be 64 characters
 *   or fewer (got 73)
 *
 * A count is not a log. These pin that the content reaches the log.
 */

import { describe, expect, test } from 'bun:test'
import { formatSpawnFailedLog } from './sentinel'

const CONV = '90dd07af-f7e1-4c18-8513-a7538e51efe9'
const REAL_LINE = 'ERR Error creating worktree: Invalid worktree name: must be 64 characters or fewer (got 73)'

describe('a failed spawn logs WHY, not how many lines it had', () => {
  test('the captured stderr line reaches the log verbatim', () => {
    const lines = formatSpawnFailedLog({
      conversationId: CONV,
      exitCode: 1,
      elapsedMs: 1209,
      hookStage: 'claude-launch',
      stderrTail: [REAL_LINE],
      preflightHints: [],
    })
    expect(lines.join('\n')).toContain(REAL_LINE)
  })

  test('the summary line still says conv, stage, exit and elapsed -- the grep anchor', () => {
    const [summary] = formatSpawnFailedLog({
      conversationId: CONV,
      exitCode: 1,
      elapsedMs: 1209,
      hookStage: 'claude-launch',
      stderrTail: [REAL_LINE],
      preflightHints: [],
    })
    expect(summary).toContain('Spawn FAILED: conv=90dd07af')
    expect(summary).toContain('[claude-launch]')
    expect(summary).toContain('exit=1')
    expect(summary).toContain('elapsed=1209ms')
    expect(summary).toContain('early failure')
  })

  test('every captured line is emitted, not just the last one', () => {
    const lines = formatSpawnFailedLog({
      conversationId: CONV,
      exitCode: 1,
      elapsedMs: 800,
      stderrTail: ['first', 'second', 'third'],
      preflightHints: [],
    })
    const body = lines.slice(1).join('\n')
    for (const l of ['first', 'second', 'third']) expect(body).toContain(l)
  })

  test('pre-flight hints are logged too -- they were only ever in the broadcast', () => {
    const lines = formatSpawnFailedLog({
      conversationId: CONV,
      exitCode: 1,
      elapsedMs: 400,
      stderrTail: [],
      preflightHints: ['config dir missing'],
    })
    expect(lines.join('\n')).toContain('config dir missing')
  })

  test('no tail, no hints -> exactly one line', () => {
    expect(
      formatSpawnFailedLog({
        conversationId: CONV,
        exitCode: 143,
        elapsedMs: 90_000,
        stderrTail: [],
        preflightHints: [],
      }),
    ).toHaveLength(1)
  })
})
