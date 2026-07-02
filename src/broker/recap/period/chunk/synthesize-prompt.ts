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
import type { ContentionDigest } from '../gather/contention-types'
import type { ConversationDigest, ForgottenThreadDigest } from '../gather/types'
import { applyRetroCf, type PresentationSelection, renderBody } from '../llm/prompt-builder'
import { renderContentionSection } from '../llm/render-contention'
import { renderForgottenSection } from '../llm/render-forgotten'
import { renderStatusSection } from '../llm/render-status'

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
  /** In-window conversations carrying a `set_status` claim (+ root provenance).
   *  Like forgotten threads, this is authoritative per-conversation data that
   *  bypasses the lossy map extraction -- injected straight into the synthesis as
   *  the highest-confidence layer. Empty/omitted when the agent_status signal is off. */
  agentStatus?: ConversationDigest[]
  /** Period-global multi-agent contention evidence. Like forgotten threads, this
   *  is authoritative deterministic data that bypasses map extraction -- injected
   *  here so a CHUNKED agentic-retrospect recap grounds its recommendations in the same
   *  collisions the oneshot path sees. Omitted when the contention signal is off. */
  contention?: ContentionDigest
}

export function buildSynthesizePrompt(
  merged: RecapMetadata,
  ctx: SynthesizeContext,
  audience: RecapAudience = 'human',
  retrospect = false,
  customerFriendly = false,
  presentation?: PresentationSelection,
  instructions?: string,
): SynthesizePrompt {
  // BOTH audiences render through the SAME template seam the oneshot path uses
  // (renderBody, `path: 'synthesize'`), so the deliverable contract (frontmatter +
  // body spec) cannot drift between the two paths -- only the framing differs
  // (synthesize: refine merged facts; oneshot: extract from transcripts). The
  // default template tracks the audience (project-recap / agent-handoff); the body
  // spec injected is keyed by audience. Pillar F (retrospect, Opus-only) + the
  // customer-friendly tone are layered on by the SHARED helper applyRetroCf --
  // identical ordering to the oneshot path, so the layering cannot drift either.
  const base = renderBody({
    path: 'synthesize',
    audience,
    scopeLabel: ctx.projectLabel,
    periodHuman: ctx.periodHuman,
    periodIsoRange: ctx.periodIsoRange,
    ...presentation,
  })
  const system = applyRetroCf(base, retrospect, customerFriendly, instructions)

  const forgottenBlock = ctx.forgotten ? renderForgottenSection(ctx.forgotten) : ''
  const statusBlock = ctx.agentStatus ? renderStatusSection(ctx.agentStatus) : ''
  const contentionBlock = renderContentionSection(ctx.contention)
  const user = `MERGED FACTS (already extracted + code-deduped across all chunks of the period):

${JSON.stringify(merged, null, 2)}
${statusBlock ? `\n${statusBlock}\n` : ''}${forgottenBlock ? `\n${forgottenBlock}\n` : ''}${contentionBlock ? `\n${contentionBlock}\n` : ''}
Synthesize the final recap now: refine + de-duplicate the above, then write the
frontmatter and body per the contract. Output the frontmatter block and body only.`

  return { system, user }
}
