/**
 * voice-refiner - optional LLM cleanup pass over a finished voice transcript.
 *
 * Two-Step ASR Post-Processing Refinement (APR), inspired by Task-Activating
 * Prompting (TAP) from "Generative Speech Recognition Error Correction with LLMs"
 * (Yang et al., 2023):
 *   Step 1 - Context Extraction: analyze the raw transcript for domain, proper
 *     nouns and likely misrecognitions.
 *   Step 2 - Refinement: clean the transcript with TAP multi-turn structure,
 *     enriched by project keyterms AND step 1's findings.
 *
 * OPT-IN, AND IT MEANS IT (2026-07-22): this used to run off a hardcoded default
 * system prompt whenever the checkbox was on, with no keyterms and no user
 * prompt. That is an LLM rewriting the user's words against NO ground truth --
 * step 1 literally invents `heard -> meant` pairs from the transcript alone and
 * step 2 then obeys them. Unconfigured now means OFF, not "improvise".
 *
 * Deliberately socket-free: it returns text and never touches the WebSocket, so
 * it stays testable and cannot import voice-stream back.
 */

import { getGlobalSettings } from './global-settings'
import { chat } from './recap/shared/openrouter-client'

const VOICE_REFINER_MODEL = 'anthropic/claude-haiku-4.5'

/**
 * Whether a refinement pass would do anything. Checked by the caller before it
 * announces `voice_refining` to the browser, and again inside refineTranscript.
 * Every falsy answer is a deliberate no-op, not a failure.
 */
export function refinementSkipReason(rawText: string): string | null {
  const settings = getGlobalSettings()
  if (!settings.voiceRefinement) return 'disabled in settings'
  if (!process.env.OPENROUTER_API_KEY) return 'no OPENROUTER_API_KEY'
  if (!rawText.trim()) return 'empty transcript'
  if (!settings.voiceRefinementPrompt?.trim()) return 'no refinement prompt configured'
  return null
}

interface ExtractedContext {
  proper_nouns?: string[]
  domain?: string
  corrections?: Array<{ heard: string; meant: string }>
  tone?: string
}

/** Step 1: ask for a compact JSON sketch of what this transcript is about. */
async function extractContext(rawText: string, apiKey: string, keyterms: string[]): Promise<string> {
  const keytermHint = keyterms.length > 0 ? `\nKnown project terms: ${keyterms.join(', ')}` : ''
  const res = await chat({
    feature: 'voice-refiner-context',
    model: VOICE_REFINER_MODEL,
    apiKey,
    system: `You analyze voice transcripts to extract context that helps correct ASR errors.${keytermHint}`,
    user: `Analyze this voice transcript and output a brief JSON object with these fields:
- "proper_nouns": names, brands, places, tools mentioned or likely intended (array of strings)
- "domain": the topic/domain (e.g. "software development", "Thai culture", "DevOps") (string)
- "corrections": any words that are likely ASR misrecognitions, with what they probably should be (array of {"heard": "x", "meant": "y"})
- "tone": the speaker's tone/register (e.g. "casual", "technical", "formal") (string)

Output ONLY valid JSON, nothing else.

${rawText}`,
    maxTokens: 512,
    temperature: 0.1,
    retries: 0,
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

/** Strip common LLM preamble patterns that leak through despite instructions. */
export function stripPreamble(text: string): string {
  const preamblePatterns = [
    /^(?:here(?:'s| is) (?:the )?(?:cleaned|corrected|refined|fixed)(?: version)?[:\s-]+)/i,
    /^(?:corrected|cleaned|refined|fixed)(?: (?:version|text|transcript))?[:\s-]+/i,
    // Punctuation required: bare "Sure enough ..." is the user's own sentence.
    /^sure[,!.]+\s*/i,
  ]
  let result = text
  for (const pattern of preamblePatterns) {
    result = result.replace(pattern, '')
  }
  return result.trim()
}

function buildMessages(systemPrompt: string, keyterms: string[], contextBlock: string, rawText: string) {
  const keytermBlock =
    keyterms.length > 0
      ? `\nDomain vocabulary (correct spellings for this project): ${keyterms.join(', ')}\nWhen the transcript contains words that sound similar to these terms, prefer the domain term.`
      : ''
  return [
    { role: 'system' as const, content: `${systemPrompt}${keytermBlock}${contextBlock}` },
    {
      role: 'user' as const,
      content: `Here's an example of a raw voice transcript and its corrected version:

Raw: "okay so um I want to add a new end point uh to the API that handles like user authentication no no wait not authentication I mean authorization slash permissions and it should use jason web tokens uh jwt for the for the token format"

Corrected: "I want to add a new endpoint to the API that handles authorization/permissions and it should use JSON Web Tokens (JWT) for the token format"

Notice how: filler words removed, self-correction applied ("not authentication, I mean authorization"), "end point" merged to "endpoint", "jason" corrected to "JSON", "slash" converted to "/", repeated words cleaned up, but the speaker's casual tone and intent are preserved exactly.`,
    },
    {
      role: 'assistant' as const,
      content:
        "Understood. I will clean the transcript by removing disfluencies, applying self-corrections, fixing ASR errors (especially technical terms and word boundaries), and converting spoken syntax to written form - while preserving the speaker's original intent and tone.",
    },
    {
      role: 'user' as const,
      content: `Clean this voice transcript. Apply all corrections. Output ONLY the cleaned text - no quotes, no explanation, no preamble, no "Here's the corrected version" prefix.

${rawText}`,
    },
  ]
}

/**
 * Refine `rawText`, or return it untouched. NEVER throws and never returns
 * empty: every failure path falls back to the raw transcript, because losing the
 * user's words to a refiner hiccup is far worse than a rough transcript.
 */
export async function refineTranscript(rawText: string, keyterms: string[]): Promise<string> {
  const skip = refinementSkipReason(rawText)
  if (skip) {
    console.log(`[voice-refiner] skipped (${skip})`)
    return rawText
  }
  const apiKey = process.env.OPENROUTER_API_KEY as string
  const systemPrompt = getGlobalSettings().voiceRefinementPrompt as string
  console.log(`[voice-refiner] Refining (${keyterms.length} keyterms):\n  RAW: "${rawText}"`)

  let contextJson = ''
  try {
    contextJson = await extractContext(rawText, apiKey, keyterms)
    console.log(`[voice-refiner] Step 1 context: ${contextJson.slice(0, 300)}`)
  } catch (err) {
    console.error('[voice-refiner] Step 1 context failed:', err)
  }

  try {
    const res = await chat({
      feature: 'voice-refiner-refine',
      model: VOICE_REFINER_MODEL,
      apiKey,
      messages: buildMessages(systemPrompt, keyterms, contextBlockFrom(contextJson), rawText),
      maxTokens: 2048,
      temperature: 0.3,
      retries: 0,
    })
    const refined = stripPreamble(res.content || rawText)
    console.log(`[voice-refiner] Refined:\n  OUT: "${refined}"`)
    return refined || rawText
  } catch (err) {
    console.error('[voice-refiner] Step 2 refinement failed:', err)
    return rawText
  }
}
