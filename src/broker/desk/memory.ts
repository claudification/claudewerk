/**
 * The dispatcher's durable MEMORY FILE (plan-dispatcher-build.md §11, Jonas's
 * memory mechanism).
 *
 * The dispatcher holds almost no context. Its long-term memory is a small,
 * human-inspectable file the loop reads at the START of every turn. After each
 * turn a cheap LLM DIGEST pass (digestTurn) decides whether anything durable is
 * worth keeping -- user preferences, project facts, ongoing goals -- and appends
 * it. It NEVER records tool calls or transient status. The file is capped, so it
 * stays a tiny rolling memory, not an ever-growing log.
 *
 * File-backed (Jonas: "a memory file") + runtime-agnostic: the LLM is a ChatFn,
 * so digestTurn unit-tests without network. Single file today (single-user
 * reality); the userId param is the seam for per-user scoping later.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ChatFn } from './classify'
import { snapshotFile } from './file-history'

/** Keep the memory the loop reads TINY -- it travels in every turn's context. */
const MAX_MEMORY_CHARS = 4000
const MAX_FACTS_PER_TURN = 3
const DIGEST_MODEL = 'anthropic/claude-haiku-4.5'

let memoryFile: string | null = null

/** Point the memory store at its file (mirrors initDispatchThreads). */
export function initDispatchMemory(cacheDir: string): void {
  memoryFile = resolve(cacheDir, 'dispatch-memory.md')
}

/** Test/explicit override of the file path. */
export function setDispatchMemoryFile(path: string): void {
  memoryFile = path
}

/** The current memory, newest-last, capped to MAX_MEMORY_CHARS (oldest dropped).
 *  Empty string when nothing is remembered yet. */
export function readMemory(_userId?: string | null): string {
  if (!memoryFile || !existsSync(memoryFile)) return ''
  const text = readFileSync(memoryFile, 'utf8')
  if (text.length <= MAX_MEMORY_CHARS) return text.trim()
  // Over cap: keep the newest tail (drop oldest lines until under the cap).
  return text
    .slice(text.length - MAX_MEMORY_CHARS)
    .replace(/^[^\n]*\n/, '')
    .trim()
}

/** Append durable facts as dated bullets. No-op for an empty list. */
export function appendMemoryFacts(facts: string[], now: number, _userId?: string | null): void {
  if (!memoryFile || facts.length === 0) return
  const clean = facts.map(f => f.trim()).filter(Boolean)
  if (clean.length === 0) return
  const stamp = new Date(now).toISOString().slice(0, 10)
  mkdirSync(dirname(memoryFile), { recursive: true })
  appendFileSync(memoryFile, `${clean.map(f => `- [${stamp}] ${f}`).join('\n')}\n`, 'utf8')
}

// ─── Version history (last 10 snapshots before each write) ─────────

/** Read the raw memory file (no cap). */
export function readMemoryRaw(): string {
  if (!memoryFile || !existsSync(memoryFile)) return ''
  return readFileSync(memoryFile, 'utf8')
}

/** Write the memory file wholesale (version backup first). */
export function writeMemory(content: string): void {
  if (!memoryFile) return
  snapshotFile(memoryFile)
  mkdirSync(dirname(memoryFile), { recursive: true })
  writeFileSync(memoryFile, content, 'utf8')
}

// ─── LLM refinement (/memory x) ───────────────────────────────────

const REFINE_SYSTEM = [
  'You maintain a TINY durable memory file for a fleet dispatcher.',
  'The user gives you the CURRENT memory file + an INSTRUCTION.',
  'Apply the instruction: add facts, remove facts, reword, reorganize,',
  'optimize -- whatever the instruction says. Output ONLY the new memory',
  'file content (markdown bullets, dated). No preamble, no explanation.',
  'Keep it under 4000 characters. Preserve existing facts unless the',
  'instruction says to change or remove them.',
].join('\n')

export interface RefineResult {
  before: string
  after: string
  model: string
}

export async function refineMemory(instruction: string, chat: ChatFn, model?: string): Promise<RefineResult> {
  const before = readMemoryRaw()
  const useModel = model || DIGEST_MODEL
  const res = await chat({
    model: useModel,
    system: REFINE_SYSTEM,
    user: `CURRENT MEMORY FILE:\n\`\`\`\n${before || '(empty)'}\n\`\`\`\n\nINSTRUCTION: ${instruction}`,
    maxTokens: 2000,
    temperature: 0,
    timeoutMs: 30_000,
    timeoutRetries: 1,
  })
  return { before, after: res.content.trim(), model: useModel }
}

// ─── Appended system prompt (/system) ──────────────────────────────

let systemAppendFile: string | null = null

export function initSystemAppend(cacheDir: string): void {
  systemAppendFile = resolve(cacheDir, 'dispatch-system-append.md')
}

export function readSystemAppend(): string {
  if (!systemAppendFile || !existsSync(systemAppendFile)) return ''
  return readFileSync(systemAppendFile, 'utf8')
}

export function writeSystemAppend(content: string): void {
  if (!systemAppendFile) return
  mkdirSync(dirname(systemAppendFile), { recursive: true })
  writeFileSync(systemAppendFile, content, 'utf8')
}

// ─── Post-turn digest ──────────────────────────────────────────────

const DIGEST_SYSTEM = [
  'You maintain a TINY durable memory for a fleet dispatcher. Given the user`s',
  'message + the dispatcher`s reply, extract 0-3 SHORT facts worth remembering',
  'LONG-TERM: user preferences, stable project facts, ongoing goals. Do NOT record',
  'tool calls, transient status, one-off requests, or chit-chat. Prefer remembering',
  'NOTHING over noise. Reply ONLY with JSON: { "facts": string[] } (empty if none).',
].join('\n')

interface DigestInput {
  intent: string
  reply: string
  existingMemory?: string
}

/** Run the post-turn digest: 0-3 durable facts to append (never tool calls). */
export async function digestTurn(input: DigestInput, chat: ChatFn): Promise<string[]> {
  const user = [
    input.existingMemory
      ? `ALREADY REMEMBERED (do not repeat):\n${input.existingMemory}`
      : 'ALREADY REMEMBERED: (nothing)',
    `USER SAID:\n${input.intent}`,
    `DISPATCHER REPLIED:\n${input.reply}`,
  ].join('\n\n')
  const res = await chat({
    model: DIGEST_MODEL,
    system: DIGEST_SYSTEM,
    user,
    responseFormat: { type: 'json_object' },
    maxTokens: 200,
    temperature: 0,
    timeoutMs: 15_000,
    timeoutRetries: 0,
  })
  return parseFacts(res.content)
}

function parseFacts(content: string): string[] {
  try {
    const first = content.indexOf('{')
    const last = content.lastIndexOf('}')
    const json = first !== -1 && last > first ? content.slice(first, last + 1) : content
    const raw = JSON.parse(json) as { facts?: unknown }
    if (!Array.isArray(raw.facts)) return []
    return raw.facts
      .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      .slice(0, MAX_FACTS_PER_TURN)
  } catch {
    return [] // a malformed digest just means "remember nothing this turn"
  }
}
