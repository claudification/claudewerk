/**
 * Per-entry classifier shared by groupEntries (batch) and useIncrementalGroups
 * (incremental). Both originally inlined the same ~200-line switch over entry
 * types -- this collapses that duplication into one named function with a
 * sub-handler per group type.
 *
 * processEntry mutates `state.groups`, `state.current`, and
 * `state.pendingSkillName`. Returning void keeps the call sites tight at both
 * callers (one `processEntry(entry, state)` per loop iteration).
 */
import type { TranscriptAssistantEntry, TranscriptEntry, TranscriptUserEntry } from '@/lib/types'
import {
  extractSkillName,
  hasRenderableMessageContent,
  isCardChannelEntry,
  isQueue,
  isSkillContent,
  NOISE_SYSTEM_SUBTYPES,
  parseTaskNotifications,
} from './parsers'
import type { DisplayGroup, GroupingState } from './types'

function handleBoot(entry: TranscriptEntry, state: GroupingState): void {
  const last = state.groups[state.groups.length - 1]
  if (last?.type === 'boot') {
    last.entries.push(entry)
  } else {
    state.current = null
    state.groups.push({ type: 'boot', timestamp: entry.timestamp || '', entries: [entry] })
  }
}

function handleLaunch(entry: TranscriptEntry, state: GroupingState): void {
  // Collect entries by launchId. A single /clear produces steps spread across
  // time (killed -> mcp_reset -> ... -> ready) and we want them all in one
  // card, but a subsequent reboot gets its own card.
  const launchId = (entry as { launchId: string }).launchId
  const last = state.groups[state.groups.length - 1]
  const lastLaunchId = (last?.entries[0] as { launchId?: string } | undefined)?.launchId
  if (last?.type === 'launch' && lastLaunchId === launchId) {
    last.entries.push(entry)
  } else {
    state.current = null
    state.groups.push({ type: 'launch', timestamp: entry.timestamp || '', entries: [entry] })
  }
}

function handleCompact(entry: TranscriptEntry, state: GroupingState): void {
  state.current = null
  // When compacted arrives, replace the preceding compacting group
  if (
    entry.type === 'compacted' &&
    state.groups.length > 0 &&
    state.groups[state.groups.length - 1].type === 'compacting'
  ) {
    state.groups[state.groups.length - 1] = {
      type: 'compacted',
      timestamp: entry.timestamp || '',
      entries: [entry],
    }
  } else {
    state.groups.push({
      type: entry.type as 'compacting' | 'compacted',
      timestamp: entry.timestamp || '',
      entries: [entry],
    })
  }
}

/** Does any entry of this user group carry exactly this string content? */
function userGroupHasText(g: DisplayGroup, content: string): boolean {
  return g.entries.some(e => {
    const c = (e as TranscriptUserEntry).message?.content
    return typeof c === 'string' && c === content
  })
}

/** Does any user group already render this text via ARRAY content (joined text
 *  blocks)? The dup-canary: flagExistingUserGroupAsQueued only matches string
 *  content, so an array copy of the same text would slip past and get a
 *  duplicate synthetic. */
function userGroupHasArrayText(content: string, state: GroupingState): boolean {
  for (const g of state.groups) {
    if (g.type !== 'user') continue
    for (const e of g.entries) {
      const c = (e as TranscriptUserEntry).message?.content
      if (!Array.isArray(c)) continue
      const text = c.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
      if (text === content) return true
    }
  }
  return false
}

/**
 * Flag an already-rendered user group as queued, when one of its entries matches
 * this text. Returns false only when the text is present in NO user group.
 *
 * Headless needs this: the agent host emits an optimistic user entry the moment
 * it writes to CC's stdin (stream-backend `sendUserMessage`), so by the time the
 * `enqueue` arrives from the JSONL the bubble already exists. Without the match
 * the message would render twice -- once normally, once as a queued ghost.
 * PTY/daemon have no optimistic entry, find no match, and keep the old
 * create-a-synthetic-group behaviour.
 *
 * TWO reasons this scans ALL user groups and ALL of each group's entries, not
 * just entries[0] of the most-recent one (both are real 2026-07-22 incidents):
 *   1. Two messages queued back-to-back MERGE into one user group, so the second
 *      enqueue's content sits at a non-zero index.
 *   2. An interrupt writes a `[Request interrupted by user]` user row that merges
 *      ahead of the real message, so the real message is not at entries[0] AND a
 *      newer user group may sit above it.
 * If a matching bubble exists ANYWHERE, flagging it (never synthesising) is the
 * only way to avoid rendering the message twice. A synthetic is created ONLY
 * when the text is genuinely absent (the PTY/daemon no-optimistic case).
 */
function flagExistingUserGroupAsQueued(content: string, state: GroupingState): boolean {
  for (let gi = state.groups.length - 1; gi >= 0; gi--) {
    const g = state.groups[gi]
    if (g.type !== 'user' || !userGroupHasText(g, content)) continue
    // Replace rather than mutate: a currently-rendering React tree must not be
    // disturbed mid-commit (React #300).
    const flagged: DisplayGroup = { ...g, queued: true }
    state.groups[gi] = flagged
    if (state.current === g) state.current = flagged
    return true
  }
  return false
}

// queue-operation: enqueue = user interject, remove = consumed by Claude.
// enqueue flags the existing user bubble (headless) or creates a queued user
// group (PTY/daemon); remove clears the queued flag on the most recent queued
// group (FIFO - multiple enqueues, bulk remove).
function handleQueue(entry: TranscriptEntry, state: GroupingState): void {
  if (!isQueue(entry)) return
  if (entry.operation === 'enqueue' && entry.content) {
    // Task-notifications are enqueued too but shouldn't float as queued.
    // They're fire-and-forget system notifications - render inline immediately.
    // Their dequeue entries may never arrive (different consumption path).
    if (entry.content.startsWith('<task-notification>')) {
      const notifications = parseTaskNotifications(entry.content)
      if (notifications.length > 0) {
        state.current = null
        state.groups.push({
          type: 'system',
          timestamp: entry.timestamp || '',
          entries: [entry],
          notifications,
        })
      }
    } else if (!flagExistingUserGroupAsQueued(entry.content, state)) {
      // Canary: we are about to synthesise a queued bubble because no user group
      // holds this text as a STRING. If a group holds the SAME text as ARRAY
      // content (an interrupted turn, a resend), the synthetic is a DUPLICATE
      // that flagExistingUserGroupAsQueued can't dedup. Warn so a recurrence is
      // greppable in devtools. (Console only -- a popped-out window has no console;
      // routing client diag over WS to the broker is tracked separately.)
      if (userGroupHasArrayText(entry.content, state)) {
        console.warn('[queue] synthesising a queued bubble whose text already renders as array content -- likely dup', {
          preview: entry.content.slice(0, 60),
          groups: state.groups.length,
        })
      }
      const synthetic: TranscriptUserEntry = {
        type: 'user',
        timestamp: entry.timestamp,
        message: { role: 'user', content: entry.content },
      }
      state.current = { type: 'user', timestamp: entry.timestamp || '', entries: [synthetic], queued: true }
      state.groups.push(state.current)
    }
  } else if (entry.operation === 'remove' || entry.operation === 'dequeue' || entry.operation === 'popAll') {
    // CC drains via `dequeue` (taken straight away, never actually held),
    // `remove` (held, then folded into a running turn) or `popAll`. Only
    // popAll clears more than the oldest queued group.
    for (let gi = 0; gi < state.groups.length; gi++) {
      const g = state.groups[gi]
      if (!g.queued) continue
      const cleared: DisplayGroup = { ...g, queued: false }
      state.groups[gi] = cleared
      if (state.current === g) state.current = cleared
      if (entry.operation !== 'popAll') break
    }
  }
}

// System messages (slash commands, api retries, informational, state changes, etc.)
// Returns true if the entry was handled (incl. silently skipped).
function handleSystem(entry: TranscriptEntry, state: GroupingState): boolean {
  if (entry.type !== 'system' || !(entry as Record<string, unknown>).subtype) return false
  const sub = (entry as Record<string, unknown>).subtype as string
  // Skip transcript-invisible noise subtypes (heartbeat status, internal
  // snapshots, subagent-only progress). Set is shared with the window's
  // displayable-budget predicate (NOISE_SYSTEM_SUBTYPES in parsers.ts): CC's
  // per-API-request `status` heartbeat + file_snapshot/post_turn_summary +
  // task_progress/task_notification all persist to the broker (events log /
  // JsonInspector) but render nothing here.
  if (NOISE_SYSTEM_SUBTYPES.has(sub)) return true

  const content = (entry as Record<string, unknown>).content as string | undefined
  // Skip raw slash command input entries (the output entry has the useful info)
  if (sub === 'local_command' && content?.includes('<command-name>')) return true

  // Inline into the current assistant run if active. Without this, every
  // system blip (api_retry, turn_duration, informational, etc.) splits a
  // run of tool calls into one-robot-per-call by resetting state.current.
  // Folding the entry into state.current.entries keeps a single avatar +
  // timestamp header while preserving timeline order -- the renderer
  // walks entries in order and emits an inline 'system' RenderItem for
  // each system entry it encounters in an assistant group.
  //
  // away_summary and background_tasks_changed are the exceptions: they render
  // as full-width bordered cards that would look wrong nested inside an
  // assistant body, so they always get their own group.
  if (state.current?.type === 'assistant' && sub !== 'away_summary' && sub !== 'background_tasks_changed') {
    state.current.entries.push(entry)
    return true
  }

  state.current = null
  state.groups.push({
    type: 'system',
    timestamp: entry.timestamp || '',
    entries: [entry],
    ...(sub === 'local_command' && content ? { localCommandOutput: content } : {}),
    systemSubtype: sub,
  })
  return true
}

// Returns true when the user entry was handled (via skip, dedup, skill, or
// notification path). Caller falls through to assistant/user merge logic when
// false.
function handleUser(entry: TranscriptEntry, state: GroupingState): boolean {
  if (entry.type !== 'user') return false
  const userEntry = entry as TranscriptUserEntry
  const content = userEntry.message?.content

  if (Array.isArray(content)) {
    // Capture skill name from Skill tool_result before skipping (Path A)
    if (content.some(c => c.type === 'tool_result')) {
      const name = extractSkillName(userEntry)
      if (name) state.pendingSkillName = name
      return true
    }
  }

  let textContent = ''
  if (typeof content === 'string') {
    textContent = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const c of content) {
      if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    }
    textContent = parts.join('')
  }

  // CC injects blocked-hook feedback (a Stop/SubagentStop hook's `reason`) as a
  // plain user entry whose first text block is "<Event> hook feedback:\n
  // <reason>". It is NOT flagged isMeta, and the content arrives as a text-block
  // array, not a string -- so match the extracted textContent. The trailing \n
  // anchor keeps a real user message that merely opens with the phrase (no
  // newline) from being caught. Hook machinery, not a user turn -> system line.
  if (/^[A-Za-z]+ hook feedback:\n/.test(textContent.trimStart())) {
    state.current = null
    state.groups.push({
      type: 'system',
      timestamp: entry.timestamp || '',
      entries: [entry],
      systemSubtype: 'hook_feedback',
    })
    return true
  }

  // Deduplicate: queue-operation enqueue creates a synthetic user group,
  // then the real user entry arrives with the same text. The synthetic has
  // no uuid (created by us), while real entries have one. Replace synthetic
  // with real to avoid showing the message twice.
  if (textContent) {
    for (let gi = state.groups.length - 1; gi >= 0; gi--) {
      const g = state.groups[gi]
      if (g.type !== 'user') continue
      const synth = g.entries[0] as unknown as Record<string, unknown> | undefined
      if (synth && !synth.uuid) {
        const synthMsg = synth as unknown as TranscriptUserEntry
        const synthText = typeof synthMsg.message?.content === 'string' ? synthMsg.message.content : undefined
        if (synthText === textContent) {
          state.groups.splice(gi, 1)
          // Reset current if it pointed at the spliced group
          if (state.current === g) state.current = null
          break
        }
      }
      break // only check the most recent user group
    }
  }

  if (textContent.includes('<system-reminder>')) return true
  if (textContent.includes('Your previous response had no visible output')) return true
  if (
    textContent.includes('<command-name>') ||
    textContent.includes('<local-command-caveat>') ||
    textContent.includes('<local-command-stdout>')
  ) {
    // A direct /slash command invocation (Path B). Render EVERY invocation as a
    // command chip -- even built-ins like /insights whose injected payload does
    // not look like a classic skill body. These used to be silently dropped, so
    // a /slash command was invisible on the web transcript (only the PTY showed
    // it). A following injected dump folds into this chip as its expandable
    // body (see the skill-content branch below).
    const name = extractSkillName(userEntry)
    if (name) {
      state.current = null
      state.groups.push({ type: 'skill', timestamp: entry.timestamp || '', entries: [], skillName: name })
      state.pendingSkillName = name
    }
    // Nameless command continuations (bare <local-command-stdout>/caveat turns)
    // carry no <command-message> -- skip them; the chip already stands for the run.
    return true
  }

  // The injected body that follows a skill/command invocation (a Skill-tool dump
  // or a built-in command's payload). Gated by pendingSkillName so only the entry
  // immediately after an invocation can match.
  if (isSkillContent(userEntry) && state.pendingSkillName) {
    state.current = null
    const last = state.groups[state.groups.length - 1]
    if (last?.type === 'skill' && last.entries.length === 0) {
      // Fold the body into the chip created by the <command-name> turn (Path B).
      // Replace the object (never mutate in place) so a currently-rendering React
      // tree is not disturbed (React #300).
      state.groups[state.groups.length - 1] = { ...last, entries: [entry] }
    } else {
      // Skill-tool path (Path A): the invocation was a tool_use, not a
      // <command-name> turn, so there is no pre-made chip -- create it now.
      state.groups.push({
        type: 'skill',
        timestamp: entry.timestamp || '',
        entries: [entry],
        skillName: state.pendingSkillName,
      })
    }
    state.pendingSkillName = undefined
    return true
  }
  state.pendingSkillName = undefined

  if (textContent.includes('<task-notification>')) {
    const notifications = parseTaskNotifications(textContent)
    if (notifications.length > 0) {
      // Dedup: queue-operation enqueue already created a system group with same notifications
      const prevSystem = state.groups[state.groups.length - 1]
      const isDuplicate =
        prevSystem?.type === 'system' &&
        prevSystem.notifications?.length === notifications.length &&
        notifications.every(n => prevSystem.notifications?.some(p => p.taskId === n.taskId && p.status === n.status))
      if (!isDuplicate) {
        state.current = null
        state.groups.push({
          type: 'system',
          timestamp: entry.timestamp || '',
          entries: [entry],
          notifications,
        })
      }
      return true
    }
  }
  return false
}

/**
 * GROUP SIZE BOUND -- max seq span merged into one user/assistant group.
 *
 * Why: virtual-core's anchorTo:'end' anchoring, wasAtEnd distance math, and
 * first-measure scroll compensation are all ITEM-granular. Unbounded merge let
 * one agentic turn become a single multi-thousand-px item (observed: 150
 * entries -> 5 groups, ~8000px inside one item, 2026-06-10 incident), so the
 * estimate-vs-measured error per item was huge and every first measurement
 * during Safari scrollback fired a large scrollTop correction mid-momentum --
 * the scrollback jerk. TanStack's chat guide assumes per-message items; this
 * bound is how the merged-group model honors that without changing visuals
 * (split groups render headerless via `continuation`).
 *
 * Buckets are ABSOLUTE (floor(seq / SPAN)), not offset-from-group-start, so a
 * regroup from ANY window start reproduces identical split points -> group ids
 * (first-entry-derived) stay stable across head-prune, window reveal, and
 * refetch. Entries without a seq never force a break (rare pre-seq raw-JSONL
 * shapes keep today's behavior).
 */
export const GROUP_SEQ_SPAN = 10

function seqBucket(entry: unknown): number | null {
  const s = (entry as { seq?: number } | undefined)?.seq
  return typeof s === 'number' ? Math.floor(s / GROUP_SEQ_SPAN) : null
}

// Merge a user-or-assistant entry into the current run-of-same-type group.
// Pre-filters empty / noise content blocks.
function mergeMessageEntry(entry: TranscriptEntry, state: GroupingState): void {
  const msgEntry = entry as TranscriptUserEntry | TranscriptAssistantEntry
  const content = msgEntry.message?.content

  // Drop content-less messages (shared gate with the window's displayable
  // budget). Only array content can be block-empty here; string content already
  // passed the non-empty check in processEntry before this call.
  if (Array.isArray(content) && !hasRenderableMessageContent(entry)) return

  const type = entry.type as 'user' | 'assistant'
  // A user group must be all-channel-card or all-normal. An inter-conversation/
  // dialog/system card and the user's own typed text are different speakers, and
  // mixing them strips the text of its chat bubble (group-view bails the whole
  // group to flat render). Split when the channel-ness flips between consecutive
  // user entries; assistant runs are unaffected.
  const sameClass =
    state.current?.type === type &&
    (type !== 'user' || isCardChannelEntry(entry) === isCardChannelEntry(state.current.entries[0]))
  // Seq-bucket size bound (see GROUP_SEQ_SPAN above): a merge never crosses an
  // absolute seq bucket, so no group grows beyond ~SPAN entries.
  const curBucket = state.current ? seqBucket(state.current.entries[0]) : null
  const newBucket = seqBucket(entry)
  const bucketBreak = curBucket !== null && newBucket !== null && newBucket !== curBucket
  if (state.current && sameClass && !bucketBreak) {
    state.current.entries.push(entry)
  } else {
    // A bucket-forced split of a same-type run is a CONTINUATION: rendered
    // headerless so the reader still sees one uninterrupted turn.
    const continuation = sameClass && bucketBreak
    state.current = {
      type,
      timestamp: entry.timestamp || '',
      entries: [entry],
      ...(continuation ? { continuation: true } : {}),
    }
    state.groups.push(state.current)
  }
}

/**
 * Apply one entry to the grouping state. Mutates state.
 *
 * Order of checks mirrors the original inline switch in groupEntries; do not
 * reorder without updating both callers + the tests covering grouping.
 */
export function processEntry(entry: TranscriptEntry, state: GroupingState): void {
  if (entry.type === 'boot') {
    handleBoot(entry, state)
    return
  }
  if (entry.type === 'launch') {
    handleLaunch(entry, state)
    return
  }
  if (entry.type === 'spawn_notification') {
    state.current = null
    state.groups.push({ type: 'spawn_notification', timestamp: entry.timestamp || '', entries: [entry] })
    return
  }
  if (entry.type === 'shell') {
    // One card per shell open/exit receipt -- never merged (each is a distinct
    // lifecycle event, possibly for different shellIds).
    state.current = null
    state.groups.push({ type: 'shell', timestamp: entry.timestamp || '', entries: [entry] })
    return
  }
  if (entry.type === 'advisor') {
    // One card per advisor() consult event (message / result / tool_result).
    state.current = null
    state.groups.push({ type: 'advisor', timestamp: entry.timestamp || '', entries: [entry] })
    return
  }
  if (entry.type === 'compacting' || entry.type === 'compacted') {
    handleCompact(entry, state)
    return
  }
  if (isQueue(entry)) {
    handleQueue(entry, state)
    return
  }
  if (handleSystem(entry, state)) return

  if (entry.type !== 'user' && entry.type !== 'assistant') return
  const msgEntry = entry as TranscriptUserEntry | TranscriptAssistantEntry
  const content = msgEntry.message?.content
  if (!content) return

  if (handleUser(entry, state)) return

  if (typeof content === 'string' && !content.trim()) return

  mergeMessageEntry(entry, state)
}

/**
 * Tag every group between EnterPlanMode and ExitPlanMode tool-use blocks with
 * `planMode = true`. Run after all entries are grouped.
 */
export function applyPlanModeTags(groups: DisplayGroup[]): void {
  let pm = false
  for (const g of groups) {
    for (const e of g.entries) {
      const blocks = (e as Record<string, unknown>).message
        ? ((e as Record<string, unknown>).message as Record<string, unknown>)?.content
        : undefined
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type === 'tool_use' && b.name === 'EnterPlanMode') pm = true
          if (b.type === 'tool_use' && b.name === 'ExitPlanMode') pm = false
        }
      }
    }
    if (pm) g.planMode = true
  }
}
