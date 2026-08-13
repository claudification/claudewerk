/**
 * The card-validation hook's whole run: the raw PostToolUse payload in, the
 * agent-facing warning block and an exit code out.
 *
 * It lives here, rather than in whichever file happens to be the entry point,
 * because there is more than one entry point and they must not drift: a machine
 * running claudewerk has the AGENT HOST installed and nothing else -- no repo,
 * no checkout -- so the shipped route is `rclaude --rclaude-validate-card`,
 * while this repo can also call the same thing through a script.
 *
 * FAILS OPEN on everything unexpected. A validator that breaks a session
 * because a board was in a shape it did not predict is worse than no validator.
 */

import { existsSync, readFileSync } from 'node:fs'
import { cardWriteTarget, checkWrittenCard } from './project-card-hook'
import { listCardIds } from './project-card-read'
import { findingLines } from './project-doctor-cli'
import { cardPath } from './project-paths'

export interface HookRunResult {
  /** 0 = nothing to say. 2 = hand `stderr` back to the model as feedback. */
  exitCode: 0 | 2
  stderr: string[]
}

const QUIET: HookRunResult = { exitCode: 0, stderr: [] }

export function runCardWriteHook(rawStdin: string): HookRunResult {
  try {
    if (!rawStdin.trim()) return QUIET
    return checkCardWritePayload(JSON.parse(rawStdin))
  } catch {
    return QUIET
  }
}

/**
 * The same check against an ALREADY-PARSED payload. The agent host takes this
 * route: its local hook server receives every PostToolUse in-process, so it can
 * answer without spawning anything.
 */
export function checkCardWritePayload(payload: unknown): HookRunResult {
  if (!payload || typeof payload !== 'object') return QUIET
  try {
    const p = payload as Record<string, unknown>
    const toolInput = (p.tool_input ?? {}) as Record<string, unknown>
    const target = cardWriteTarget(String(p.tool_name ?? ''), String(toolInput.file_path ?? ''))
    if (!target) return QUIET

    const findings = checkWrittenCard(target, {
      readFile: (root, id) => {
        const abs = cardPath(root, id, false)
        return existsSync(abs) ? readFileSync(abs, 'utf8') : null
      },
      listIds: listCardIds,
    })
    if (findings.length === 0) return QUIET

    return {
      exitCode: 2,
      stderr: [
        `Board card \`${target.id}\` has ${findings.length} problem(s):`,
        ...findings.flatMap(findingLines),
        '',
        'Fix them in the card you just wrote. (`board:doctor` checks the whole board.)',
      ],
    }
  } catch {
    return QUIET
  }
}

/**
 * Read the hook payload from stdin (fd 0). Deliberately `node:fs` rather than
 * `Bun.stdin`: this module sits in `src/shared`, which the control panel's
 * tsconfig also typechecks, and the Bun global does not exist there.
 */
export function readHookStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return '' // no stdin -- run by hand, or a hook harness that sends nothing
  }
}
