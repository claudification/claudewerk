/**
 * CHUNKED:Intermediary -- the map stage prompt (Pillar A).
 *
 * Pure EXTRACTION, not synthesis: pull the facts (features/bugs/fixes/incidents/
 * decisions/dead_ends/gotchas + keyword lists) out of ONE chunk's transcripts as
 * strict JSON shaped like RecapMetadata. No prose, no narrative, no judgment --
 * those belong to CHUNKED:Final (Opus) on the merged JSON. Facts extracted here
 * merge + dedup deterministically in code (merge.ts); opinions/prose are the
 * reduce's job. (Jonas: "the intermediary chunking LLM calls must be different
 * than the HUMAN OUTPUT last refinement LLM calls.")
 *
 * The system prompt is a STABLE CONSTANT (no per-chunk or per-recap text) so it
 * sits first in the request and OpenRouter prompt-caches it across every chunk of
 * a recap AND across eval-harness variants that share a map model. Only the user
 * message (this chunk's transcripts) varies.
 */

import type { RecapItem, RecapMetadata } from '../../../../shared/protocol'
import { findFirstJsonObject } from '../../shared/json-parse'
import { makeEmptyMetadata } from '../chunk/merge'
import { renderTranscriptsSection, shortId } from '../llm/render-transcripts'
import type { TranscriptChunk } from './split'

export interface MapPrompt {
  system: string
  user: string
}

export class MapParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message)
    this.name = 'MapParseError'
  }
}

/** Stable, recap-agnostic extraction contract. Keep this BYTE-CONSTANT -- any
 *  per-recap interpolation here defeats cross-recap prompt caching. */
export const MAP_SYSTEM_PROMPT = `You are an EXTRACTION worker in a map-reduce recap pipeline. You are given the
transcripts of ONE chunk of a larger period (other chunks are processed
separately, then everything is merged). Your ONLY job is to pull the FACTS out of
THIS chunk as strict JSON. You are NOT writing a recap, a narrative, or prose --
a later stage does that from the merged facts.

Output ONLY a single JSON object (no markdown fence, no commentary) with these keys
(omit none -- use [] when a chunk has nothing for a key):

  {
    "keywords":      string[],   // technical terms: feature/file/component/library/model/table names seen in THIS chunk
    "hashtags":      string[],   // 0-8 broader themes, each prefixed with # (e.g. "#sqlite-migration")
    "goals":         string[],   // things being attempted in this chunk
    "discoveries":   string[],   // findings, bugs identified, learnings, surprises
    "side_effects":  string[],   // unintended consequences, scope creep, debt incurred
    "open_questions":string[],   // unresolved questions the assistant left for the user (verbatim where shown)
    "stakeholders":  string[],   // people involved/mentioned by name
    "features":  Item[],   // shipped features
    "bugs":      Item[],   // bugs fixed
    "fixes":     Item[],   // refactors / cleanups
    "incidents": Item[],   // production/dev incidents
    "decisions": Item[],   // non-obvious decisions + WHY (reasoning a diff cannot show)
    "dead_ends": Item[],   // approaches tried then ABANDONED + why they failed
    "gotchas":   Item[]    // constraints/landmines discovered (tool/env quirks, surprising failures)
  }

Item = {
  "title":         string,        // concise, specific -- use the project's real terms verbatim
  "detail"?:       string,        // one line of extra context (the WHY, the reason it failed, etc.)
  "conversations"?:string[],      // 8-char conversation ids from THIS chunk that evidence the item
  "commits"?:      string[],      // 7-char commit hashes where the input shows them
  "inferred"?:     boolean        // true if concluded from transcript text only (NOT backed by a commit/task)
}

RULES:
  - GROUND EVERY ITEM. Cite the conversation id (8-char) and commit hash (7-char)
    the input shows for it. An item with no citation and no "inferred": true is noise -- drop it.
  - FACT vs INFERENCE. Backed by a commit/task = FACT (inferred omitted or false).
    Concluded from transcript text only = set "inferred": true. Never dress inference as fact.
  - EXTRACT, do not invent. If the chunk shows nothing for a key, return [] -- never pad to fill a quota.
  - This chunk may be PARTIAL (only some turns of a long conversation). Extract only what you see;
    do not speculate about the rest of that conversation.
  - Output the JSON object and nothing else.`

/** Build the map prompt for one chunk. The user message carries only this chunk's
 *  transcripts (+ a partial-conversation note) so the constant system prompt caches. */
export function buildMapPrompt(chunk: TranscriptChunk): MapPrompt {
  const parts: string[] = []
  if (chunk.partialConversationIds.length > 0) {
    const ids = chunk.partialConversationIds.map(shortId).join(', ')
    parts.push(
      `NOTE: this chunk contains only PART of conversation(s) ${ids} (split across chunks). Extract only from the turns shown below.`,
    )
  }
  parts.push(renderTranscriptsSection(chunk.transcripts))
  parts.push('Extract the facts from the transcripts above as the JSON object specified. Output JSON only.')
  return { system: MAP_SYSTEM_PROMPT, user: parts.join('\n\n') }
}

/** Parse a map-stage response into RecapMetadata. Tolerant of stray prose/fences
 *  around the JSON (findFirstJsonObject), strict about the shape (coerced). Throws
 *  MapParseError when no JSON object can be recovered at all. */
export function parseMapOutput(raw: string): RecapMetadata {
  const candidate = findFirstJsonObject(raw)
  if (!candidate) throw new MapParseError('map output contains no JSON object', raw)
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(candidate) as Record<string, unknown>
  } catch (err) {
    throw new MapParseError(`map output JSON parse failed: ${(err as Error).message}`, raw)
  }
  const out = makeEmptyMetadata()
  out.keywords = stringArray(obj.keywords)
  out.hashtags = stringArray(obj.hashtags)
  out.goals = stringArray(obj.goals)
  out.discoveries = stringArray(obj.discoveries)
  out.side_effects = stringArray(obj.side_effects)
  out.open_questions = stringArray(obj.open_questions)
  out.stakeholders = stringArray(obj.stakeholders)
  out.features = itemArray(obj.features)
  out.bugs = itemArray(obj.bugs)
  out.fixes = itemArray(obj.fixes)
  out.incidents = itemArray(obj.incidents)
  out.decisions = itemArray(obj.decisions)
  out.dead_ends = itemArray(obj.dead_ends)
  out.gotchas = itemArray(obj.gotchas)
  return out
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
  }
  return out
}

function itemArray(value: unknown): RecapItem[] {
  if (!Array.isArray(value)) return []
  const out: RecapItem[] = []
  for (const raw of value) {
    const item = coerceItem(raw)
    if (item) out.push(item)
  }
  return out
}

function coerceItem(raw: unknown): RecapItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title.trim() : ''
  if (!title) return null
  const detail = typeof o.detail === 'string' && o.detail.trim() ? o.detail.trim() : undefined
  const conversations = stringArray(o.conversations)
  const commits = stringArray(o.commits)
  const inferred = o.inferred === true || o.inferred === 'true'
  return {
    title,
    ...(detail ? { detail } : {}),
    ...(conversations.length ? { conversations } : {}),
    ...(commits.length ? { commits } : {}),
    ...(inferred ? { inferred: true } : {}),
  }
}
