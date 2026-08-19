/**
 * CC's background turn classifier -- `system/post_turn_summary`.
 *
 * CC ships its own classifier (remote config `tengu_bg_classifier_config`:
 * small fast model, thinking off, 60s mid-turn debounce). It answers the
 * question our quick-recap does badly: what is this conversation doing RIGHT
 * NOW, in the present tense.
 *
 * It only reaches the stream-json wire when the spawn env opts in:
 *
 *     CLAUDE_CODE_ENVIRONMENT_KIND=byoc     -- creates the "ccr" surface,
 *                                              whose sink is "summary"
 *     CLAUDE_CODE_CLASSIFIER_SUMMARY=1      -- forces the engine locally
 *
 * Both are required. The surface alone works only while a server-side flag
 * happens to default the engine on; without CLASSIFIER_SUMMARY the engine
 * resolves to null and CC emits nothing at all.
 *
 * `byoc` and NOT `bridge`, deliberately: both reach the summary sink, but
 * `bridge` also feeds CC's MCP `deadlineMs` calculation and can impose a
 * connection deadline where there was none. `byoc`'s only other effect is a
 * Datadog telemetry gate.
 *
 * Anthropic can withdraw this at any time (`tengu_classifier_summary_kill`,
 * `tengu_classifier_disabled_surfaces`, `tengu_cobalt_wren`), and it is
 * main-agent-only -- no subagent rows. So it is an accelerator, never the only
 * source of conversation state.
 *
 * Full findings + a reproducible probe: `.claude/docs/plan-conversation-classifier.md`
 */

import type { TurnSummary } from '../shared/protocol'

/** Env an agent host must pass to CC for `post_turn_summary` to reach the wire.
 *  Spread into the spawn env; see the module doc for why `byoc` over `bridge`. */
export const TURN_SUMMARY_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_ENVIRONMENT_KIND: 'byoc',
  CLAUDE_CODE_CLASSIFIER_SUMMARY: '1',
})

/** The parsed summary, minus `updatedAt` -- the host stamps that when it sends,
 *  so the wire clock has a single owner. Shape lives in shared/protocol. */
export type ParsedTurnSummary = Omit<TurnSummary, 'updatedAt'>

/** Parse a `system/post_turn_summary` payload into a TurnSummary.
 *
 *  Returns null for the priming message CC emits at turn start (it carries no
 *  detail) and for any payload whose detail is missing or blank -- an empty
 *  label is worse than none, because a fleet dashboard is read at a glance. */
export function parseTurnSummary(msg: Record<string, unknown>): ParsedTurnSummary | null {
  const detail = typeof msg.status_detail === 'string' ? msg.status_detail.trim() : ''
  if (!detail) return null

  const category = typeof msg.status_category === 'string' && msg.status_category ? msg.status_category : 'review_ready'
  const needsAction = typeof msg.needs_action === 'string' ? msg.needs_action.trim() : ''
  const summarizesUuid = typeof msg.summarizes_uuid === 'string' ? msg.summarizes_uuid : undefined

  return {
    category,
    detail,
    ...(needsAction && { needsAction }),
    ...(summarizesUuid && { summarizesUuid }),
  }
}
