import type { RecapAudience } from '../../../../shared/protocol'

// OpenRouter slugs (pinned, like the broker's other recap models). Human recaps
// default to Opus -- the rich, fully-cited report needs the strongest judgment
// and prose. Agent briefs stay on Sonnet (good judgment at lower cost). Both are
// overridable via env for cost tuning without a code change. CLAUDWERK_ is the
// canonical prefix (RCLAUDE_ legacy fallback).
const SONNET_MODEL = 'anthropic/claude-sonnet-4'
const OPUS_MODEL = 'anthropic/claude-opus-4.8'

const HUMAN_MODEL = process.env.CLAUDWERK_RECAP_HUMAN_MODEL || process.env.RCLAUDE_RECAP_HUMAN_MODEL || OPUS_MODEL
const AGENT_MODEL = process.env.CLAUDWERK_RECAP_AGENT_MODEL || process.env.RCLAUDE_RECAP_AGENT_MODEL || SONNET_MODEL

// Above this input size, fall back to Sonnet regardless of audience: Opus at
// 600k+ context is needlessly expensive and the marginal quality gain is small.
const CHUNK_CEILING_CHARS = 600_000

export interface ModelChoice {
  model: string
  reason: 'human-floor' | 'agent-floor' | 'too-big'
}

export function pickModel(inputChars: number, audience: RecapAudience = 'human'): ModelChoice {
  if (inputChars > CHUNK_CEILING_CHARS) return { model: SONNET_MODEL, reason: 'too-big' }
  if (audience === 'agent') return { model: AGENT_MODEL, reason: 'agent-floor' }
  return { model: HUMAN_MODEL, reason: 'human-floor' }
}
