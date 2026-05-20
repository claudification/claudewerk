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

import { translateClaudeToolResult, translateClaudeToolUse } from '../claude-agent-host/dialect/from-claude'
import { createTranscriptWatcher, type TranscriptWatcher } from '../claude-agent-host/transcript-watcher'
import type { HostTransport } from '../shared/host-transport'
import type { TranscriptContentBlock, TranscriptEntry } from '../shared/protocol'
import { transcriptJsonlPath } from './transcript-path'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TranscriptBridgeOptions {
  transport: HostTransport
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
  resend(): Promise<void>
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
  const { transport, onError, debug } = opts

  let watcher: TranscriptWatcher | null = null
  let stopped = false
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
      onEntries(entries, isInitial) {
        if (stopped) return
        translateBlocks(entries, toolNameByUseId)
        transport.sendTranscriptEntries(entries, isInitial)
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

  async function resend(): Promise<void> {
    if (!watcher) return
    await watcher.resend()
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
