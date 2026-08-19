/**
 * Turn raw CC transcript lines into the context an intent classifier reads.
 *
 * Production code, not benchmark-only: this is the context builder under the
 * ONE intent primitive (name / title / description / intent). The naming
 * benchmark imports it so the thing being measured is the thing that ships.
 *
 * Two conversation shapes break naming prompts in different ways, and the
 * split below is what lets a caller treat them differently:
 *
 *   NEW  -- one user message, zero results. Nothing to summarize but the ask;
 *           the failure mode is padding, inventing progress that never happened.
 *   LONG -- many user messages plus real results. Two failure modes: TAIL BIAS
 *           (reporting the last follow-up -- "thanks", "commit that" -- as the
 *           topic) and MISSION STALENESS (the first message freezing as the
 *           label long after the work changed direction).
 */

export interface IntentUserMessage {
  text: string
  atMs: number
}

export interface IntentContext {
  /** Every human turn, oldest first. The first is the mission; later ones may
   *  supersede it. Callers apply recency weighting -- this only extracts. */
  userMessages: IntentUserMessage[]
  /** Condensed activity: assistant text snippets and tool labels. */
  activity: string[]
}

interface ContentPart {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

/** User turns: the text parts only. A tool_result-only turn is plumbing, not
 *  intent, and yields nothing. */
function userText(parts: ContentPart[]): string {
  return parts
    .filter(p => p?.type === 'text')
    .map(p => p.text ?? '')
    .join(' ')
    .trim()
}

/** One assistant part as an activity bit. The Bash `description` field is a
 *  free, human-written label for the action -- tier 2 of the classifier design,
 *  and already present on every Bash call we have ever stored. */
function activityBit(p: ContentPart): string | undefined {
  if (p?.type === 'text') return p.text?.trim()?.slice(0, 200) || undefined
  if (p?.type !== 'tool_use') return undefined
  const desc = typeof p.input?.description === 'string' ? p.input.description : undefined
  return desc ? `[${p.name}] ${desc}` : `[${p.name}]`
}

const BY_ROLE: Record<string, (parts: ContentPart[]) => { user?: string; activity?: string }> = {
  user: parts => {
    const text = userText(parts)
    return text ? { user: text } : {}
  },
  assistant: parts => {
    const bits = parts.map(activityBit).filter((b): b is string => !!b)
    return bits.length ? { activity: bits.join(' | ') } : {}
  },
}

/**
 * Pull the human-readable bits out of one raw CC transcript line.
 *
 * Deliberately shallow: the JSONL shape varies by CC version, so this reads the
 * parts it understands and returns nothing for anything else. A malformed line
 * must never take down a classify pass or a benchmark run.
 */
export function extractText(content: string): { user?: string; activity?: string } {
  try {
    const msg = (JSON.parse(content) as { message?: { role?: string; content?: unknown } }).message
    const parts = Array.isArray(msg?.content) ? (msg.content as ContentPart[]) : []
    return BY_ROLE[msg?.role ?? '']?.(parts) ?? {}
  } catch {
    return {}
  }
}

/** Is this a brand-new conversation (nothing but the ask) or a running one? */
export function conversationShape(ctx: IntentContext): 'new' | 'long' {
  return ctx.userMessages.length <= 2 ? 'new' : 'long'
}

/**
 * Text that arrives on a `user` turn but is the HARNESS talking, not the human.
 *
 * Found by benchmarking: several real conversations named themselves after
 * `"Stop hook feedback: You did real work this turn but never called
 * set_status..."`, because hook output is injected as a user message. A
 * classifier reading that describes our own tooling instead of the work.
 *
 * Matched at the START only -- a human quoting a hook mid-sentence is still the
 * human, and dropping their whole message would be worse than keeping it.
 */
const INJECTED_PREFIXES = [
  '<', // <system-reminder>, <channel>, <forked...>
  'stop hook feedback',
  'posttooluse:',
  'pretooluse:',
  'caveat: the messages below',
  '[image:', // an image placeholder carries no intent text
  'this session is being continued',
]

function isInjected(text: string): boolean {
  const head = text.trimStart().toLowerCase()
  return INJECTED_PREFIXES.some(p => head.startsWith(p))
}

/**
 * Fold raw transcript lines into classifier context.
 *
 * Harness-injected turns are dropped: they are not the human, and counting them
 * both misreads the shape and hands the classifier our own plumbing to name.
 */
export function buildIntentContext(lines: Array<{ content: string; atMs: number }>, maxActivity = 25): IntentContext {
  const userMessages: IntentUserMessage[] = []
  const activity: string[] = []
  for (const line of lines) {
    const { user, activity: act } = extractText(line.content)
    if (user && !isInjected(user)) userMessages.push({ text: user.slice(0, 2000), atMs: line.atMs })
    if (act) activity.push(act)
  }
  return { userMessages, activity: activity.slice(-maxActivity) }
}
