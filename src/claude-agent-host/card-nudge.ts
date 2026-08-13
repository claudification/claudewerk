/**
 * Tell an agent it just wrote a bad board card -- without spawning anything.
 *
 * The settings file rclaude generates already routes EVERY PostToolUse to this
 * host's local HTTP server, and that route already answers with a
 * `{decision:'block', reason}` body when it has something to say (the set_status
 * Stop nudge got there first). So the card check rides the same wire: the
 * payload is already in this process, and the warning goes back as the hook
 * command's stdout.
 *
 * That is what makes this work everywhere. No `.claude/settings.json` entry, no
 * per-machine wiring, no second process per Write -- every rclaude session in
 * every project gets it because every rclaude session already has these hooks.
 */

import { checkCardWritePayload } from '../shared/project-card-hook-run'
import type { HookEvent } from '../shared/protocol'
import type { HookDecision } from './status-nudge'

/**
 * A warning for the card this tool call just wrote, or undefined -- which is the
 * answer for every tool call that did not write one, i.e. almost all of them.
 */
export function computeCardNudge(event: HookEvent): HookDecision | undefined {
  if (event.hookEvent !== 'PostToolUse' || !event.data) return undefined
  const { exitCode, stderr } = checkCardWritePayload(event.data)
  if (exitCode === 0) return undefined
  return { decision: 'block', reason: stderr.join('\n') }
}
