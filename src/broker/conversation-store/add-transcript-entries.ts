import type {
  TranscriptAssistantEntry,
  TranscriptEntry,
  TranscriptProgressEntry,
  TranscriptUserEntry,
} from '../../shared/protocol'
import { appendSharedFile } from '../routes'
import { MAX_TRANSCRIPT_ENTRIES } from './constants'
import { assignTranscriptSeqs, type ConversationStoreContext } from './event-context'
import { detectClipboardMime, detectContextModeFromStdout, isReadableText } from './parsers'

/**
 * Persist a batch of transcript entries to the cache + derive session-level
 * stats / metadata from them. Re-broadcasts compaction markers and live
 * subagent transcripts. No-op when conversation isn't registered.
 *
 * Pulled out of createConversationStore wholesale (was 430+ lines inside
 * the factory). Behavior unchanged -- ConversationStoreContext supplies
 * everything that used to be a closure capture.
 */
export function addTranscriptEntries(
  ctx: ConversationStoreContext,
  conversationId: string,
  entries: TranscriptEntry[],
  isInitial: boolean,
): void {
  const {
    conversations,
    transcriptCache,
    transcriptSeqCounters,
    dirtyTranscripts,
    processedClipboardIds,
    scheduleConversationUpdate,
    broadcastToChannel,
    broadcastConversationScoped,
    addSubagentTranscriptEntries,
  } = ctx

  // Stamp seqs BEFORE cache insert and BEFORE any broadcast the caller does.
  // All entries in `entries` are mutated in place with `entry.seq = N`.
  // Callers (handlers/transcript.ts, handlers/boot-lifecycle.ts) then
  // broadcast the same objects, so the wire payload carries seqs too.
  assignTranscriptSeqs(transcriptSeqCounters, conversationId, entries, isInitial)
  if (isInitial) {
    transcriptCache.set(conversationId, entries.slice(-MAX_TRANSCRIPT_ENTRIES))
  } else {
    const existing = transcriptCache.get(conversationId) || []
    existing.push(...entries)
    if (existing.length > MAX_TRANSCRIPT_ENTRIES) {
      transcriptCache.set(conversationId, existing.slice(-MAX_TRANSCRIPT_ENTRIES))
    } else {
      transcriptCache.set(conversationId, existing)
    }
  }
  dirtyTranscripts.add(conversationId)

  // Extract stats from transcript entries
  const session = conversations.get(conversationId)
  let sessionChanged = false
  if (session) {
    // Ensure stats object exists (sessions created before this feature)
    if (!session.stats || isInitial) {
      // Reset stats + metadata on initial load to avoid double-counting when
      // transcript watcher re-reads the full file (restart, reconnect, truncation recovery)
      session.summary = undefined
      if (!session.titleUserSet) session.title = undefined // preserve user-set titles (spawn dialog)
      session.agentName = undefined
      session.prLinks = undefined
      session.stats = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreation: 0,
        totalCacheWrite5m: 0,
        totalCacheWrite1h: 0,
        totalCacheRead: 0,
        turnCount: 0,
        toolCallCount: 0,
        compactionCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
        totalApiDurationMs: 0,
      }
    }
    for (const entry of entries) {
      // Extract git branch from any entry (gitBranch is on TranscriptEntryBase)
      if (!session.gitBranch && entry.gitBranch) {
        session.gitBranch = entry.gitBranch
        sessionChanged = true
      }

      // Count user turns
      if (entry.type === 'user') {
        const userEntry = entry as TranscriptUserEntry
        const content = userEntry.message?.content
        // Only count actual user messages, not tool results
        if (typeof content === 'string' || (Array.isArray(content) && content.some(c => c.type === 'text'))) {
          if (!Array.isArray(content) || !content.some(c => c.type === 'tool_result')) {
            session.stats.turnCount++
          }
        }
      }

      // Count compactions (synthetic marker from hooks OR native JSONL compact_boundary)
      if (entry.type === 'compacted') {
        session.stats.compactionCount++
      }
      if (entry.type === 'system' && (entry as Record<string, unknown>).subtype === 'compact_boundary') {
        if (isInitial) {
          // On initial transcript load, just count for stats
          session.stats.compactionCount++
          session.compactedAt = new Date(entry.timestamp || 0).getTime()
        } else {
          // Live: cross-check against hook-based detection.
          // If hooks already handled this compaction (compactedAt set recently), skip.
          const recentlyCompacted = session.compactedAt && Date.now() - session.compactedAt < 30_000
          if (!recentlyCompacted && !session.compacting) {
            session.compactedAt = Date.now()
            session.stats.compactionCount++
            const marker = { type: 'compacted' as const, timestamp: entry.timestamp || new Date().toISOString() }
            // Recursive call goes through ctx so the cycle stays explicit
            ctx.addTranscriptEntries(conversationId, [marker], false)
            broadcastToChannel('conversation:transcript', conversationId, {
              type: 'transcript_entries',
              conversationId,
              entries: [marker],
              isInitial: false,
            })
            sessionChanged = true
            console.log(`[compact] detected via JSONL compact_boundary (session ${conversationId.slice(0, 8)})`)
          }
        }
      }

      // Detect effective context mode from /model or /context stdout.
      // These appear as `user` entries with string content wrapping <local-command-stdout>,
      // or `system` entries with subtype 'local_command'.
      {
        let stdoutContent: string | undefined
        if (entry.type === 'user') {
          const c = (entry as TranscriptUserEntry).message?.content
          if (typeof c === 'string' && c.includes('local-command-stdout')) stdoutContent = c
        } else if (entry.type === 'system' && (entry as Record<string, unknown>).subtype === 'local_command') {
          const c = (entry as Record<string, unknown>).content
          if (typeof c === 'string') stdoutContent = c
        }
        if (stdoutContent) {
          const mode = detectContextModeFromStdout(stdoutContent)
          if (mode && session.contextMode !== mode) {
            session.contextMode = mode
            sessionChanged = true
            console.log(`[meta] context mode: ${mode} (session ${conversationId.slice(0, 8)})`)
          }
        }
      }

      // Extract recap from away_summary transcript entries
      if (entry.type === 'system' && (entry as Record<string, unknown>).subtype === 'away_summary') {
        const content = (entry as Record<string, unknown>).content
        if (typeof content === 'string' && content.trim()) {
          const recapTs = new Date(entry.timestamp || 0).getTime()
          session.recap = { content: content.trim(), timestamp: recapTs }
          session.recapFresh = session.lastActivity <= recapTs + 10_000
          // CC writes away_summary precisely because the conversation has gone idle long enough
          // to need a "what were we doing" summary. If we still have the conversation as 'active'
          // from earlier activity, flip it to 'idle' -- the recap landing is itself proof.
          if (session.status === 'active') {
            session.status = 'idle'
          }
          sessionChanged = true
        }
      }

      // Extract transcript-derived metadata from special entry types
      if (entry.type === 'summary') {
        const s = (entry as Record<string, unknown>).summary
        if (typeof s === 'string' && s.trim()) {
          session.summary = s.trim()
          sessionChanged = true
          console.log(`[meta] summary: "${session.summary.slice(0, 60)}" (session ${conversationId.slice(0, 8)})`)
        }
      }
      if (entry.type === 'custom-title') {
        const t = (entry as Record<string, unknown>).customTitle
        if (typeof t === 'string' && t.trim()) {
          session.title = t.trim()
          sessionChanged = true
          console.log(`[meta] title: "${session.title}" (session ${conversationId.slice(0, 8)})`)
        }
      }
      if (entry.type === 'agent-name') {
        const n = (entry as Record<string, unknown>).agentName
        if (typeof n === 'string' && n.trim()) {
          session.agentName = n.trim()
          sessionChanged = true
          console.log(`[meta] agent: "${session.agentName}" (session ${conversationId.slice(0, 8)})`)
        }
      }
      if (entry.type === 'pr-link') {
        const e = entry as Record<string, unknown>
        const prNumber = e.prNumber as number | undefined
        const prUrl = e.prUrl as string | undefined
        const prRepository = e.prRepository as string | undefined
        if (prNumber && prUrl) {
          if (!session.prLinks) session.prLinks = []
          // Deduplicate by prUrl
          if (!session.prLinks.some(p => p.prUrl === prUrl)) {
            session.prLinks.push({
              prNumber,
              prUrl,
              prRepository: prRepository || '',
              timestamp: (e.timestamp as string) || new Date().toISOString(),
            })
            console.log(
              `[meta] pr-link: ${prRepository}#${prNumber} (session ${conversationId.slice(0, 8)}, total: ${session.prLinks.length})`,
            )
            sessionChanged = true
          }
        }
      }

      // Detect OSC 52 clipboard sequences in Bash tool results.
      // Skip on initial transcript loads to avoid re-surfacing old captures on reconnect.
      // Deduplicate by tool_use_id to prevent re-processing on transcript re-reads.
      if (!isInitial && entry.type === 'user') {
        const userContent = (entry as TranscriptUserEntry).message?.content
        if (Array.isArray(userContent)) {
          for (const block of userContent) {
            if (block.type !== 'tool_result' || typeof block.content !== 'string') continue
            const toolUseId = block.tool_use_id as string | undefined
            if (toolUseId && processedClipboardIds.has(toolUseId)) continue
            // Match OSC 52: direct (\x1b]52;c;BASE64\x07) or tmux-wrapped (Ptmux;\x1b]52;c;BASE64)
            const osc52Match =
              block.content.match(/(?:\x1bPtmux;\x1b)?(?:\x1b)?\]52;[a-z]*;([A-Za-z0-9+/=]+)/) ||
              block.content.match(/Ptmux;[^\]]*\]52;[a-z]*;([A-Za-z0-9+/=]+)/)
            if (osc52Match?.[1] && osc52Match[1].length > 8) {
              const base64 = osc52Match[1]
              const mime = detectClipboardMime(base64)
              const decodedText = mime ? undefined : Buffer.from(base64, 'base64').toString('utf-8')
              // Skip garbled/binary content that isn't readable text
              if (!mime && (!decodedText || !isReadableText(decodedText))) {
                if (toolUseId) processedClipboardIds.add(toolUseId)
                continue
              }
              const capture = {
                type: 'clipboard_capture' as const,
                conversationId,
                contentType: mime ? ('image' as const) : ('text' as const),
                ...(mime ? { base64, mimeType: mime } : { text: decodedText }),
                timestamp: Date.now(),
              }
              broadcastConversationScoped(capture, session.project)
              if (toolUseId) processedClipboardIds.add(toolUseId)
              // Persist to shared files log (per-project, survives restarts)
              const clipHash = `clip_${Date.now().toString(36)}_${base64.slice(0, 8)}`
              appendSharedFile({
                type: 'clipboard',
                hash: clipHash,
                filename: mime ? `clipboard.${mime.split('/')[1]}` : 'clipboard.txt',
                mediaType: mime || 'text/plain',
                project: session.project,
                conversationId,
                size: base64.length,
                url: '',
                text: decodedText,
                createdAt: Date.now(),
              })
              console.log(`[clipboard] ${capture.contentType} from transcript (session ${conversationId.slice(0, 8)})`)
            }
          }
        }
      }

      // Extract turn_duration from system entries
      if (!isInitial && entry.type === 'system') {
        const sysEntry = entry as { subtype?: string; durationMs?: number }
        if (sysEntry.subtype === 'turn_duration' && typeof sysEntry.durationMs === 'number') {
          session.stats.totalApiDurationMs += sysEntry.durationMs
          sessionChanged = true
        }
      }

      // Count lines changed from Edit/MultiEdit structuredPatch on tool results
      if (!isInitial && entry.type === 'user') {
        const userContent = (entry as TranscriptUserEntry).message?.content
        if (Array.isArray(userContent)) {
          for (const block of userContent) {
            if (block.type !== 'tool_result') continue
            const tur = (block as unknown as Record<string, unknown>).toolUseResult as
              | Record<string, unknown>
              | undefined
            const patches = tur?.structuredPatch as Array<{ lines?: string[] }> | undefined
            if (!Array.isArray(patches)) continue
            for (const hunk of patches) {
              if (!Array.isArray(hunk.lines)) continue
              for (const line of hunk.lines) {
                if (line.startsWith('+')) session.stats.linesAdded++
                else if (line.startsWith('-')) session.stats.linesRemoved++
              }
            }
            sessionChanged = true
          }
        }
      }

      if (entry.type !== 'assistant') continue
      const assistantEntry = entry as TranscriptAssistantEntry

      // Count tool calls
      const content = assistantEntry.message?.content
      if (Array.isArray(content)) {
        session.stats.toolCallCount += content.filter(c => c.type === 'tool_use').length
      }

      // Extract model from assistant messages as last-resort fallback.
      // Init message (session.model) is ground truth. Assistant messages
      // strip context-window suffixes like [1m], so only use when nothing
      // better is available.
      const assistantModel = assistantEntry.message?.model
      if (assistantModel && typeof assistantModel === 'string' && assistantModel !== '<synthetic>' && !session.model) {
        session.model = assistantModel
      }

      // Extract token usage (latest = context window, cumulative = totals).
      // Skip `<synthetic>` assistant blocks (auto-compact summaries, recap,
      // hook-injected messages). They aren't real API turns and carry zeroed
      // usage that would clobber the last real context-window snapshot.
      const usage = assistantEntry.message?.usage
      if (usage && typeof usage.input_tokens === 'number' && assistantModel !== '<synthetic>') {
        session.tokenUsage = {
          input: usage.input_tokens || 0,
          cacheCreation: usage.cache_creation_input_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
          output: usage.output_tokens || 0,
        }
        // Extract 5m/1h cache write split from usage.cache_creation
        const cc = usage.cache_creation as Record<string, number> | undefined
        const cw5m = cc?.ephemeral_5m_input_tokens || 0
        const cw1h = cc?.ephemeral_1h_input_tokens || 0
        // Fallback: if total cache_creation > sum of 5m+1h, remainder -> 5m bucket
        const cwTotal = usage.cache_creation_input_tokens || 0
        const cwRemainder = Math.max(0, cwTotal - cw5m - cw1h)

        // Determine dominant cache TTL tier for this turn
        if (cw5m + cwRemainder > 0 || cw1h > 0) {
          session.cacheTtl = cw1h > cw5m + cwRemainder ? '1h' : '5m'
        }

        session.stats.totalInputTokens += (usage.input_tokens || 0) + cwTotal + (usage.cache_read_input_tokens || 0)
        session.stats.totalOutputTokens += usage.output_tokens || 0
        session.stats.totalCacheCreation += cwTotal
        session.stats.totalCacheWrite5m += cw5m + cwRemainder
        session.stats.totalCacheWrite1h += cw1h
        session.stats.totalCacheRead += usage.cache_read_input_tokens || 0
        sessionChanged = true

        // Record estimated cost snapshot for PTY sessions (headless uses turn_cost)
        if (!session.stats.totalCostUsd) {
          if (!session.costTimeline) session.costTimeline = []
          // Estimate cost using split cache write pricing (5m=1.25x, 1h=2.0x input price)
          const s = session.stats
          const uncached = Math.max(0, s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead)
          const est =
            (uncached * 15 +
              s.totalOutputTokens * 75 +
              s.totalCacheRead * 1.875 +
              s.totalCacheWrite5m * 18.75 +
              s.totalCacheWrite1h * 30) /
            1_000_000
          session.costTimeline.push({ t: Date.now(), cost: est })
          if (session.costTimeline.length > 500) {
            session.costTimeline = session.costTimeline.slice(-500)
          }
        }
      }
    }
  }

  // Detect bg task completions from <task-notification> in user transcript entries
  if (session?.bgTasks.some(t => t.status === 'running')) {
    for (const entry of entries) {
      if (entry.type !== 'user') continue
      const msg = entry.message as Record<string, unknown> | undefined
      const content = msg?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((c: Record<string, unknown>) => c.type === 'text')
                .map((c: Record<string, unknown>) => c.text)
                .join('')
            : ''
      if (!text.includes('<task-notification>')) continue

      // Extract task IDs and statuses
      const re = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g
      let match: RegExpExecArray | null = re.exec(text)
      while (match !== null) {
        const taskId = match[1]
        const status = match[2]
        const bgTask = session.bgTasks.find(t => t.taskId === taskId && t.status === 'running')
        if (bgTask) {
          bgTask.status = status === 'completed' ? 'completed' : 'killed'
          bgTask.completedAt = Date.now()
          sessionChanged = true
        }
        match = re.exec(text)
      }
    }
  }

  // Extract live subagent transcript entries from parent transcript
  // During runtime, agent progress is embedded in parent transcript with data.agentId
  if (session) {
    const agentEntries = new Map<string, TranscriptEntry[]>()
    for (const entry of entries) {
      const agentId =
        entry.type === 'progress' ? ((entry as TranscriptProgressEntry).data?.agentId as string | undefined) : undefined
      if (agentId && typeof agentId === 'string') {
        let batch = agentEntries.get(agentId)
        if (!batch) {
          batch = []
          agentEntries.set(agentId, batch)
        }
        batch.push(entry)
      }
    }
    // Push to subagent transcript cache + broadcast, and remove from parent cache
    if (agentEntries.size > 0) {
      for (const [agentId, agentBatch] of agentEntries) {
        console.log(
          `[transcript] ${conversationId.slice(0, 8)}... live agent ${agentId.slice(0, 7)} ${agentBatch.length} entries from parent`,
        )
        addSubagentTranscriptEntries(conversationId, agentId, agentBatch, false)
        broadcastToChannel(
          'conversation:subagent_transcript',
          conversationId,
          {
            type: 'subagent_transcript',
            conversationId,
            agentId,
            entries: agentBatch,
            isInitial: false,
          },
          agentId,
        )
      }
      // Filter extracted agent entries out of parent cache (they were copied, not moved)
      const agentEntrySet = new Set([...agentEntries.values()].flat())
      const cached = transcriptCache.get(conversationId)
      if (cached) {
        transcriptCache.set(
          conversationId,
          cached.filter(e => !agentEntrySet.has(e)),
        )
      }
    }
  }

  if (session && sessionChanged) {
    scheduleConversationUpdate(conversationId)
  }
}
