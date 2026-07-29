/**
 * Transcript Bridge
 *
 * Watches the JSONL transcript file written by a Claude Code daemon worker
 * and forwards translated entries to the broker via HostTransport.
 *
 * JSONL path rule: see `transcript-path.ts` -- the bridge resolves the JSONL
 * path via `transcriptJsonlPath(cwd, ccSessionId)`.
 *
 * On /clear the daemon worker's ccSessionId rotates. Call watch() again with
 * the new ccSessionId -- the bridge stops the old watcher, clears the
 * tool-name map, and starts fresh on the new file.
 */

import { renameRequestsIn } from '../claude-agent-host/detect-rename'
import { translateClaudeToolResult, translateClaudeToolUse } from '../claude-agent-host/dialect/from-claude'
import { stampDeterministicUuids } from '../claude-agent-host/entry-uuid'
import { cutKnownPrefix } from '../claude-agent-host/resend-cursor'
import { createTranscriptWatcher, type TranscriptWatcher } from '../claude-agent-host/transcript-watcher'
import type { HostTransport } from '../shared/host-transport'
import type { TranscriptContentBlock, TranscriptEntry } from '../shared/protocol'
import { transcriptJsonlPath } from './transcript-path'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TranscriptBridgeOptions {
  transport: HostTransport
  /** OUR stable conversation id (not the worker's ccSessionId) -- the rename
   *  messages this bridge emits are addressed to the broker by it. */
  conversationId: string
  onError?: (err: Error) => void
  debug?: (msg: string) => void
}

export interface TranscriptBridge {
  /** Start (or re-point) the JSONL watcher for a ccSessionId. Safe to call
   *  repeatedly: on /clear the worker's ccSessionId rotates and this
   *  re-points at the new file. */
  watch(ccSessionId: string, cwd: string): Promise<void>
  /** Re-read the whole current transcript file and re-send it as the initial
   *  batch. No-op if no watcher is running. */
  resend(knownUuids?: string[]): Promise<void>
  /** Stop watching. Idempotent. */
  stop(): void
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

/** Translate tool_use / tool_result blocks in place before forwarding. */
function translateBlocks(entries: TranscriptEntry[], toolNameByUseId: Map<string, string>): void {
  for (const entry of entries) {
    const msg = (entry as { message?: { content?: unknown[] } }).message
    if (!Array.isArray(msg?.content)) continue
    if (entry.type === 'assistant') {
      for (const block of msg.content as TranscriptContentBlock[]) {
        if (block.type !== 'tool_use') continue
        translateClaudeToolUse(block)
        const useId = block.id ?? ''
        const name = block.name ?? ''
        if (useId && name) toolNameByUseId.set(useId, name)
      }
    } else if (entry.type === 'user') {
      const tur = (entry as Record<string, unknown>).toolUseResult
      for (const block of msg.content as TranscriptContentBlock[]) {
        if (block.type !== 'tool_result') continue
        translateClaudeToolResult(block, tur, toolNameByUseId)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTranscriptBridge(opts: TranscriptBridgeOptions): TranscriptBridge {
  const { transport, conversationId, onError, debug } = opts

  let watcher: TranscriptWatcher | null = null
  let stopped = false
  /** Broker-known uuids, armed by a cursored resend and consumed by its emit. */
  let resendKnown: Set<string> | null = null
  // One map per session -- cleared on each watch() re-point.
  const toolNameByUseId = new Map<string, string>()

  async function watch(ccSessionId: string, cwd: string): Promise<void> {
    if (stopped) return
    // Stop any existing watcher and reset session-scoped state.
    if (watcher) {
      watcher.stop()
      watcher = null
    }
    toolNameByUseId.clear()

    const path = transcriptJsonlPath(cwd, ccSessionId)
    debug?.(`watch: pointing at ${path}`)

    watcher = createTranscriptWatcher({
      onEntries(rawEntries, isInitial) {
        if (stopped) return
        // Stamp before cutting: the entries CC leaves unidentified only have a
        // uuid to match the broker's cursor against once we have given them one.
        stampDeterministicUuids(rawEntries)
        const cut = isInitial ? cutKnownPrefix(rawEntries, resendKnown) : { entries: rawEntries, skipped: 0 }
        if (cut.skipped) debug?.(`resend: broker already had ${cut.skipped}/${rawEntries.length}, sending the rest`)
        const entries = cut.entries
        if (entries.length === 0) return
        translateBlocks(entries, toolNameByUseId)
        transport.sendTranscriptEntries(entries, isInitial)
        // A `/rename` typed inside the daemon worker reaches us only as a JSONL
        // entry -- there is no stdout stream here. Without this the daemon fleet
        // could not rename itself at all. Not gated on isInitial: the rename
        // carries CC's own clock, so the broker drops a replayed one as stale.
        for (const msg of renameRequestsIn(conversationId, entries)) {
          debug?.(`detected /rename: "${msg.name}" (at=${msg.at ?? 'undated'})`)
          transport.send(msg)
        }
      },
      onError(err) {
        onError?.(err)
      },
      debug,
      // claude --bg returns the worker short BEFORE CC creates the JSONL.
      // Give the file a window to appear so the bridge does not silently
      // no-op on the dispatch->attach race.
      waitForFileMs: 15_000,
    })

    await watcher.start(path)
  }

  async function resend(knownUuids?: string[]): Promise<void> {
    if (!watcher) return
    // Armed for the next emit and consumed there -- see resend-cursor.ts. The
    // daemon reads only the JSONL, so unlike headless every entry the broker
    // knows about has a counterpart here and the cursor almost always matches.
    resendKnown = knownUuids?.length ? new Set(knownUuids) : null
    await watcher.resend()
    resendKnown = null
  }

  function stop(): void {
    stopped = true
    if (watcher) {
      watcher.stop()
      watcher = null
    }
  }

  return { watch, resend, stop }
}
