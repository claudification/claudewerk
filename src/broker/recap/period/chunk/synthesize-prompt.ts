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
import { AGENT_BODY_SPEC, FRONTMATTER_SPEC, HUMAN_BODY_SPEC } from '../llm/prompt-builder'

export interface SynthesizePrompt {
  system: string
  user: string
}

export interface SynthesizeContext {
  projectLabel: string
  periodHuman: string
  periodIsoRange: string
}

export function buildSynthesizePrompt(
  merged: RecapMetadata,
  ctx: SynthesizeContext,
  audience: RecapAudience = 'human',
): SynthesizePrompt {
  const bodySpec = audience === 'agent' ? AGENT_BODY_SPEC : HUMAN_BODY_SPEC
  const reader =
    audience === 'agent'
      ? 'a fresh Claude Code agent session with zero prior context, about to do real work in this project'
      : 'a human reading a development recap'
  const system = `You are SYNTHESIZING the final recap for project ${ctx.projectLabel},
covering ${ctx.periodHuman} (${ctx.periodIsoRange}). The reader is ${reader}.

The facts below were already EXTRACTED from the period's transcripts in parallel
(map stage) and MERGED + de-duplicated IN CODE. Your job is JUDGMENT and PROSE,
NOT extraction:
  - REFINE the merged items: collapse near-duplicates the code merge missed
    (same thing, different wording), keep the most specific title, merge details.
  - PRESERVE every citation (conversation ids, commit hashes) and every
    "inferred" flag exactly as given -- never upgrade an inference to a fact.
  - DO NOT invent items, citations, or facts that are not in the merged input.
    You have no transcripts here; everything you state must trace to the input.
  - DROP anything genuinely empty; never pad to fill a section.

Output format: a YAML frontmatter block (between --- lines) followed by the
markdown body. The frontmatter is parsed and indexed -- carry the merged facts
into it faithfully.

${FRONTMATTER_SPEC}

${bodySpec}`

  const user = `MERGED FACTS (already extracted + code-deduped across all chunks of the period):

${JSON.stringify(merged, null, 2)}

Synthesize the final recap now: refine + de-duplicate the above, then write the
frontmatter and body per the contract. Output the frontmatter block and body only.`

  return { system, user }
}
