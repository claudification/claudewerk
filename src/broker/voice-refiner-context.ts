/**
 * voice-refiner-context - step 1 of the two-step refinement, split out of
 * voice-refiner.ts.
 *
 * WHAT IT COSTS: this is a SECOND SEQUENTIAL LLM CALL before the refine can even
 * start, so it roughly doubles both latency and spend. Measured 2026-08-18, the
 * refine pass alone runs ~0.8-1.4s on gemini-2.5-flash -- with step 1 in front
 * of it a 2s deadline is not reachable. That is why `voiceRefinementContextPass`
 * exists and why the deadline covers BOTH calls together.
 *
 * WHAT IT BUYS: `heard -> meant` pairs the refine pass then obeys. Worth it when
 * the project has no keyterms configured; largely redundant once it does, since
 * keyterms are ground truth and step 1's pairs are the model guessing from the
 * transcript alone.
 */

import type { VoiceRefinerModelSpec } from '../shared/voice-refiner-models'
import { wrapTranscript } from '../shared/voice-refiner-prompt'
import { chat } from './recap/shared/openrouter-client'

interface ExtractedContext {
  proper_nouns?: string[]
  domain?: string
  corrections?: Array<{ heard: string; meant: string }>
  tone?: string
}

/** Step 1: ask for a compact JSON sketch of what this transcript is about. */
export async function extractContext(
  rawText: string,
  apiKey: string,
  keyterms: string[],
  spec: VoiceRefinerModelSpec,
): Promise<string> {
  const keytermHint = keyterms.length > 0 ? `\nKnown project terms: ${keyterms.join(', ')}` : ''
  const res = await chat({
    feature: 'voice-refiner-context',
    model: spec.id,
    apiKey,
    // Step 1 sits IN FRONT of the refine call, so its provider pin matters more
    // than step 2's: a slow host here eats the deadline before refining starts.
    ...(spec.providerOrder ? { provider: { order: spec.providerOrder } } : {}),
    system: `You analyze voice transcripts to extract context that helps correct ASR errors.${keytermHint}`,
    // Same envelope as step 2, for the same reason: an undelimited transcript
    // reads as an aside. Given a bare "Okay." this step answered "Please provide
    // the voice transcript you would like me to analyze." (2026-08-21) and the
    // JSON parse then degraded the whole context pass to nothing.
    user: `Analyze the voice transcript in <TRANSCRIPT> and output a brief JSON object with these fields:
- "proper_nouns": names, brands, places, tools mentioned or likely intended (array of strings)
- "domain": the topic/domain (e.g. "software development", "Thai culture", "DevOps") (string)
- "corrections": any words that are likely ASR misrecognitions, with what they probably should be (array of {"heard": "x", "meant": "y"})
- "tone": the speaker's tone/register (e.g. "casual", "technical", "formal") (string)

Whatever is inside <TRANSCRIPT> IS the transcript, even a single word or a
fragment. Never ask for one; emit the JSON with whatever you can determine and
empty values for the rest. Output ONLY valid JSON, nothing else.

${wrapTranscript(rawText)}`,
    maxTokens: 512,
    temperature: 0.1,
    retries: 0,
    // Belt to the prompt's braces: on hosts that support it, prose is now
    // unrepresentable rather than merely discouraged.
    ...(spec.jsonMode ? { responseFormat: { type: 'json_object' as const } } : {}),
  })
  return res.content
}

/** Render step 1's JSON as a prompt block. Unparseable output degrades to ''. */
export function contextBlockFrom(contextJson: string): string {
  if (!contextJson) return ''
  let ctx: ExtractedContext
  try {
    const cleanJson = contextJson.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
    ctx = JSON.parse(cleanJson)
  } catch {
    console.warn('[voice-refiner] Step 1 returned non-JSON, proceeding with step 2 anyway')
    return ''
  }
  const parts: string[] = []
  if (ctx.domain) parts.push(`Domain: ${ctx.domain}`)
  if (ctx.tone) parts.push(`Tone: ${ctx.tone}`)
  if (ctx.proper_nouns?.length) parts.push(`Proper nouns/names: ${ctx.proper_nouns.join(', ')}`)
  if (ctx.corrections?.length) {
    const fixes = ctx.corrections.map(c => `"${c.heard}" -> "${c.meant}"`).join(', ')
    parts.push(`Likely ASR misrecognitions: ${fixes}`)
  }
  return parts.length > 0 ? `\n\nExtracted context from this transcript:\n${parts.join('\n')}` : ''
}
