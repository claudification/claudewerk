/**
 * CHUNKED:Final -- the reduce/synthesis stage prompt (Pillar A).
 *
 * Input: the MERGED, code-deduped facts (one RecapMetadata) from every chunk's
 * map output. Job: judgment + prose -- collapse near-duplicates the code merge
 * missed, then write the human/agent narrative body. This is the ONLY chunked
 * stage that does synthesis, and it runs on Opus (the strongest judgment).
 *
 * CRITICAL: the output must round-trip parseRecapOutput -- a YAML frontmatter
 * block between --- lines followed by the markdown body, in the EXACT contract
 * the oneshot path uses (FRONTMATTER_SPEC + body spec shared from prompt-builder),
 * so the rest of the pipeline (renderFinalMarkdown/digest/FTS) is untouched.
 */

import type { RecapAudience, RecapMetadata } from '../../../../shared/protocol'
import type { ForgottenThreadDigest } from '../gather/types'
import {
  AGENT_BODY_SPEC,
  AGENT_SYNTHESIZE_READER,
  applyRetroCf,
  FRONTMATTER_SPEC,
  type PresentationSelection,
  renderHumanBody,
  synthesizeFraming,
} from '../llm/prompt-builder'
import { renderForgottenSection } from '../llm/render-forgotten'

export interface SynthesizePrompt {
  system: string
  user: string
}

export interface SynthesizeContext {
  projectLabel: string
  periodHuman: string
  periodIsoRange: string
  /** Period-global forgotten threads. These bypass map extraction (the
   *  conversations are outside the chunks), so they're injected here as an
   *  authoritative deterministic block alongside the merged facts. */
  forgotten?: ForgottenThreadDigest
}

export function buildSynthesizePrompt(
  merged: RecapMetadata,
  ctx: SynthesizeContext,
  audience: RecapAudience = 'human',
  retrospect = false,
  customerFriendly = false,
  presentation?: PresentationSelection,
): SynthesizePrompt {
  // The HUMAN body is rendered through the SAME template seam the oneshot path
  // uses (renderHumanBody, `path: 'synthesize'`), so the deliverable contract
  // (frontmatter + body spec) cannot drift between the two paths -- only the
  // framing differs (synthesize: refine merged facts; oneshot: extract from
  // transcripts). The AGENT body is not templated yet (agent-handoff = phase 4),
  // so it is assembled in code below. Pillar F (retrospect, Opus-only) + the
  // customer-friendly tone are layered on by the SHARED helper applyRetroCf --
  // identical ordering to the oneshot path, so the layering cannot drift either.
  const base =
    audience === 'agent'
      ? agentSynthesizeBody(ctx)
      : renderHumanBody({
          path: 'synthesize',
          scopeLabel: ctx.projectLabel,
          periodHuman: ctx.periodHuman,
          periodIsoRange: ctx.periodIsoRange,
          ...presentation,
        })
  const system = applyRetroCf(base, retrospect, customerFriendly)

  const forgottenBlock = ctx.forgotten ? renderForgottenSection(ctx.forgotten) : ''
  const user = `MERGED FACTS (already extracted + code-deduped across all chunks of the period):

${JSON.stringify(merged, null, 2)}
${forgottenBlock ? `\n${forgottenBlock}\n` : ''}
Synthesize the final recap now: refine + de-duplicate the above, then write the
frontmatter and body per the contract. Output the frontmatter block and body only.`

  return { system, user }
}

/**
 * The agent orientation-brief synthesize body: the shared synthesize framing
 * (agent reader) + the frontmatter contract + the agent body spec. Not templated
 * yet -- the agent-handoff template lands in phase 4, at which point this routes
 * through {@link renderHumanBody}'s sibling like the human path does today.
 */
function agentSynthesizeBody(ctx: SynthesizeContext): string {
  const framing = synthesizeFraming(ctx.projectLabel, ctx.periodHuman, ctx.periodIsoRange, AGENT_SYNTHESIZE_READER)
  return `${framing}\n\n${FRONTMATTER_SPEC}\n\n${AGENT_BODY_SPEC}`
}
