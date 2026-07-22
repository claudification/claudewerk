/**
 * Transcript JSONL File Watcher
 * Watches Claude transcript files for new entries, parses them,
 * processes inline images (extract base64 -> blob hash), and emits entries.
 *
 * Uses directory-level native fs.watch (Bun 1.3.14) so that /clear and
 * compaction -- which mint a NEW transcript file in the same dir -- keep firing
 * events. (Bun 1.3.14 fixed the older macOS fs.watch close/reopen bug that once
 * forced a chokidar workaround here.) A post-read stat drain + a low-frequency
 * poll cover fs.watch's inherent event coalescing under bursty writes.
 */

import { access, type FileHandle, open, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { type TreeWatcher, watchTree } from '../shared/fs-watch'
import type { TranscriptEntry } from '../shared/protocol'

/** Parse JSONL lines with Bun.JSONL fast path + manual fallback */
function parseJsonlLines(lines: string[], debug?: (msg: string) => void): TranscriptEntry[] {
  if (typeof Bun !== 'undefined' && Bun.JSONL) {
    try {
      const text = lines.filter(l => l.trim()).join('\n')
      if (!text) return []
      return Bun.JSONL.parse(text) as TranscriptEntry[]
    } catch {
      debug?.('Bun.JSONL.parse failed, falling back to per-line parsing')
    }
  }
  const entries: TranscriptEntry[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry)
    } catch {
      debug?.(`malformed JSON line (${trimmed.length} chars)`)
    }
  }
  return entries
}

export interface TranscriptWatcherOptions {
  onEntries: (entries: TranscriptEntry[], isInitial: boolean) => void
  onNewFile?: (filename: string) => void
  onError?: (error: Error) => void
  debug?: (msg: string) => void
  /**
   * Poll for the JSONL to exist before opening it. Daemon workers register
   * with the daemon before CC creates their transcript file, so callers that
   * attach right after `claude --bg` returns the short id can race the file
   * into existence. Default 0 (no wait -- preserves the old behavior for
   * agent-host paths that always see an existing file).
   */
  waitForFileMs?: number
  /**
   * Emit the file's existing content as the initial batch on `start()`.
   * Default true.
   *
   * `false` = seek-to-end: the first read still runs (to establish the byte
   * offset and the entry count) but its entries are NOT emitted, so the
   * watcher only reports what is appended from now on. Headless needs this:
   * stdout already owns the boot transcript there, and an `isInitial` batch
   * REPLACES the broker's transcript cache -- racing the stdout replay-buffer
   * flush would clobber it.
   *
   * Scoped to that first read only. A later truncation/compaction reset still
   * emits its `isInitial` batch, and `resend()` still works, so recovery is
   * unaffected.
   */
  emitInitial?: boolean
}

export interface TranscriptWatcher {
  start: (path: string) => Promise<void>
  stop: () => void
  resend: () => Promise<void>
  getEntryCount: () => number
  /** File currently being watched ('' before start). Lets callers tell a real
   *  file change from a redundant re-point. */
  getPath: () => string
}

/**
 * Create a watcher for a single JSONL transcript file.
 * Reads from the last known offset, parses new lines, emits entries.
 */
export function createTranscriptWatcher(options: TranscriptWatcherOptions): TranscriptWatcher {
  const { onEntries, onNewFile, onError, debug, waitForFileMs = 0, emitInitial = true } = options

  let fileHandle: FileHandle | null = null
  let watcher: TreeWatcher | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let offset = 0
  let entryCount = 0
  let partial = '' // leftover bytes from incomplete last line
  let reading = false
  let pendingRead = false
  let stopped = false
  let filePath = ''
  // Set only for the duration of the first read in start() when emitInitial is
  // false. Guards the emit, never the offset bookkeeping -- see emitInitial.
  let suppressInitialEmit = false

  async function readNewLines(isInitial_: boolean): Promise<void> {
    let isInitial = isInitial_
    if (reading || stopped || !fileHandle) {
      if (reading && !stopped) pendingRead = true
      return
    }
    reading = true

    try {
      const { size } = await stat(filePath)
      if (size < offset) {
        // File was truncated/compacted (Claude Code context compression rewrites the JSONL)
        debug?.(`readNewLines: file truncated (size=${size} < offset=${offset}), resetting`)
        offset = 0
        partial = ''
        entryCount = 0
        // Re-read as initial batch since the old data is gone
        isInitial = true
      }
      if (size === offset) {
        reading = false
        return
      }

      debug?.(`readNewLines: size=${size} offset=${offset} toRead=${size - offset}`)

      const buf = Buffer.allocUnsafe(size - offset)
      const { bytesRead } = await fileHandle.read(buf, 0, buf.length, offset)
      if (bytesRead === 0) {
        debug?.(`readNewLines: 0 bytes read despite size delta`)
        reading = false
        return
      }
      offset += bytesRead

      const text = partial + buf.toString('utf-8', 0, bytesRead)
      const lines = text.split('\n')

      // Last element might be incomplete if file is still being written
      partial = lines.pop() || ''

      const entries = parseJsonlLines(lines, debug)

      debug?.(`readNewLines: ${lines.length} lines, ${entries.length} entries, partial=${partial.length} chars`)

      if (entries.length > 0) {
        entryCount += entries.length
        if (isInitial && suppressInitialEmit) {
          debug?.(`readNewLines: seek-to-end, ${entries.length} pre-existing entries not emitted`)
        } else if (isInitial && entries.length > 500) {
          // On initial read, send the tail (ring buffer caps at 500) but preserve
          // metadata entries from earlier in the transcript (summary, title, pr-link, etc.)
          const METADATA_TYPES = new Set(['summary', 'custom-title', 'agent-name', 'pr-link'])
          const tail = entries.slice(-500)
          const tailSet = new Set(tail)
          const metadata = entries.filter(
            e => METADATA_TYPES.has((e as Record<string, unknown>).type as string) && !tailSet.has(e),
          )
          onEntries([...metadata, ...tail], isInitial)
        } else {
          onEntries(entries, isInitial)
        }
      }
    } catch (err) {
      if (!stopped) {
        onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      reading = false
      // fs.watch on macOS coalesces/drops `change` events under bursty writes
      // (only 1 event fires for ~10 rapid appendFile calls). The pendingRead
      // mechanism above only catches events that arrived DURING a read; it can't
      // recover bytes that arrived AFTER the read with no follow-up event. So
      // we re-stat post-read: if more bytes are on disk, drain them now.
      if (!stopped && fileHandle) {
        try {
          const { size } = await stat(filePath)
          if (size > offset || pendingRead) {
            pendingRead = false
            readNewLines(false)
          }
        } catch {
          // stat failure here means the file vanished; the next fs.watch event
          // (if any) will surface the error. No point swallowing twice.
        }
      } else if (pendingRead) {
        pendingRead = false
      }
    }
  }

  async function start(path: string): Promise<void> {
    filePath = path
    stopped = false
    offset = 0
    partial = ''
    entryCount = 0

    if (waitForFileMs > 0) {
      const deadline = Date.now() + waitForFileMs
      while (Date.now() < deadline) {
        if (stopped) return
        try {
          await access(path)
          break
        } catch {
          await new Promise<void>(r => setTimeout(r, 100))
        }
      }
    }

    try {
      fileHandle = await open(path, 'r')
      debug?.(`File opened OK`)
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(`Cannot open transcript: ${err}`))
      return
    }

    // Read existing content as initial batch. With emitInitial=false the read
    // still runs -- it is what establishes the byte offset -- but its entries
    // are swallowed, leaving the watcher tailing from EOF.
    suppressInitialEmit = !emitInitial
    await readNewLines(true)
    suppressInitialEmit = false
    debug?.(`Initial read done, entryCount=${entryCount}${emitInitial ? '' : ' (seek-to-end, not emitted)'}`)

    // Watch the PARENT DIRECTORY (not the file): /clear + compaction mint a new
    // transcript file in the same dir and we must keep firing for it. Any event
    // on the current file -> drain it; an 'add' of a different .jsonl -> new file.
    const dir = dirname(path)
    const absPath = resolve(path)
    watcher = watchTree({
      dir,
      onEvent(event, changedAbs) {
        if (changedAbs === absPath) {
          debug?.(`fs.watch event on transcript`)
          readNewLines(false)
        } else if (event === 'add' && changedAbs.endsWith('.jsonl')) {
          const name = changedAbs.split('/').pop() || changedAbs
          debug?.(`New transcript file detected: ${name}`)
          onNewFile?.(name)
        }
      },
      onError(err) {
        if (!stopped) onError?.(err)
      },
    })
    debug?.(`Native dir watcher setup OK: ${dir}`)

    // Safety-net poll for fs.watch/macOS event drops. Under bursty writes
    // (e.g. CC streaming many tool results in tight succession), fs.watch
    // sometimes fires only one `change` event for a series of appends, and
    // the post-read stat in readNewLines can't catch bytes that arrive after
    // it. A low-frequency stat closes that gap without the CPU cost of full
    // polling. 500ms is well below human-noticeable latency for transcript
    // updates, and the stat is a no-op when offset matches size.
    pollTimer = setInterval(() => {
      if (stopped || reading) return
      stat(filePath)
        .then(({ size }) => {
          if (!stopped && size > offset) {
            debug?.(`poll: size=${size} > offset=${offset}, draining`)
            readNewLines(false)
          }
        })
        .catch(() => {
          // file gone -- next chokidar event (or its absence) will surface it
        })
    }, 500)
  }

  function stop(): void {
    stopped = true
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (watcher) {
      watcher.close()
      watcher = null
    }
    if (fileHandle) {
      fileHandle.close().catch(() => {})
      fileHandle = null
    }
  }

  async function resend(): Promise<void> {
    if (!filePath || stopped) return
    debug?.(`resend: re-reading full file from offset 0`)
    // Re-read entire file from start, emit as initial
    const savedOffset = offset
    offset = 0
    partial = ''
    reading = false
    pendingRead = false
    await readNewLines(true)
    debug?.(`resend: done, offset now ${offset} (was ${savedOffset})`)
  }

  function getEntryCount(): number {
    return entryCount
  }

  function getPath(): string {
    return filePath
  }

  return { start, stop, resend, getEntryCount, getPath }
}
