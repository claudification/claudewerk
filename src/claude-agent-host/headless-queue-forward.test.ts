/**
 * Integration: the headless transport tailing the real JSONL through the real
 * watcher and the real transcript-manager send path.
 *
 * Covers the seam the unit tests cannot: that a headless agent host forwards
 * CC's `queue-operation` entries live while NOT re-forwarding the user /
 * assistant entries stdout already delivered, and that an explicit resend
 * flips to the complementary set.
 */

import { describe, expect, it } from 'bun:test'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptEntry } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { resendTranscriptFromFile, startTranscriptWatcher } from './transcript-manager'

interface Sent {
  entries: TranscriptEntry[]
  isInitial: boolean
}

/** Minimal headless-shaped ctx: enough for the watcher -> send path. */
function makeCtx(sent: Sent[], headless: boolean): AgentHostContext {
  return {
    headless,
    cwd: '/tmp',
    conversationId: 'conv_test',
    claudeSessionId: 'cc-session',
    parentTranscriptPath: '',
    transcriptWatcher: null,
    subagentWatchers: new Map(),
    pendingTranscriptEntries: [],
    diag: () => {},
    debug: () => {},
    wsClient: {
      isConnected: () => true,
      send: () => {},
      sendTranscriptEntries: (entries: TranscriptEntry[], isInitial: boolean) => {
        sent.push({ entries: [...entries], isInitial })
      },
    },
  } as unknown as AgentHostContext
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`

const USER = { type: 'user', timestamp: '2026-07-22T04:41:27.149Z', message: { role: 'user', content: 'run it' } }
const ASSISTANT = { type: 'assistant', timestamp: '2026-07-22T04:41:34.822Z', message: { role: 'assistant' } }
const ENQUEUE = {
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp: '2026-07-22T04:41:38.000Z',
  content: 'QUEUED-MESSAGE',
}
const REMOVE = {
  type: 'queue-operation',
  operation: 'remove',
  timestamp: '2026-07-22T04:42:05.583Z',
  content: 'QUEUED-MESSAGE',
}

async function withTranscript(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'hqf-'))
  try {
    await fn(join(dir, 'transcript.jsonl'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const flatten = (sent: Sent[]) => sent.flatMap(s => s.entries)
const types = (sent: Sent[]) => flatten(sent).map(e => e.type)

describe('headless queue-operation forwarding', () => {
  it('forwards queue-operations appended after boot, and nothing else', async () => {
    await withTranscript(async path => {
      // Pre-existing transcript: stdout already delivered all of this.
      await writeFile(path, line(USER) + line(ASSISTANT))

      const sent: Sent[] = []
      const ctx = makeCtx(sent, true)
      ctx.parentTranscriptPath = path
      await startTranscriptWatcher(ctx, path)
      await delay(150)

      expect(sent).toEqual([])

      // CC queues a mid-turn message, then drains it at a tool_result boundary.
      await appendFile(path, line(ENQUEUE))
      await delay(400)
      await appendFile(path, line({ ...USER, timestamp: '2026-07-22T04:42:05.581Z' }) + line(REMOVE))
      await delay(400)

      ctx.transcriptWatcher?.stop()

      // The user entry appended alongside `remove` is stdout's job, not ours.
      expect(types(sent)).toEqual(['queue-operation', 'queue-operation'])
      const ops = flatten(sent).map(e => (e as unknown as { operation: string }).operation)
      expect(ops).toEqual(['enqueue', 'remove'])
      expect(sent.every(s => s.isInitial === false)).toBe(true)
    })
  })

  it('gives the enqueue and its same-millisecond dequeue distinct uuids', async () => {
    // CC writes both on the same ms when a message is taken straight away. If
    // they collide the broker drops the dequeue and the badge never clears.
    await withTranscript(async path => {
      await writeFile(path, '')

      const sent: Sent[] = []
      const ctx = makeCtx(sent, true)
      ctx.parentTranscriptPath = path
      await startTranscriptWatcher(ctx, path)
      await delay(150)

      const ts = '2026-07-22T04:30:32.949Z'
      await appendFile(
        path,
        line({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: 'hi' }) +
          line({ type: 'queue-operation', operation: 'dequeue', timestamp: ts }),
      )
      await delay(400)

      ctx.transcriptWatcher?.stop()

      const uuids = flatten(sent).map(e => e.uuid)
      expect(uuids).toHaveLength(2)
      expect(uuids[0]).toBeTruthy()
      expect(uuids[0]).not.toBe(uuids[1])
    })
  })

  it('resend sends the conversation and withholds the queue-operations', async () => {
    await withTranscript(async path => {
      await writeFile(path, line(USER) + line(ENQUEUE) + line(ASSISTANT) + line(REMOVE))

      const sent: Sent[] = []
      const ctx = makeCtx(sent, true)
      ctx.parentTranscriptPath = path
      await startTranscriptWatcher(ctx, path)
      await delay(150)
      expect(sent).toEqual([])

      resendTranscriptFromFile(ctx)
      await delay(400)

      ctx.transcriptWatcher?.stop()

      expect(types(sent)).toEqual(['user', 'assistant'])
      expect(sent[0].isInitial).toBe(true)
    })
  })

  it('PTY is unchanged: the whole file, queue-operations included', async () => {
    await withTranscript(async path => {
      await writeFile(path, line(USER) + line(ENQUEUE) + line(ASSISTANT) + line(REMOVE))

      const sent: Sent[] = []
      const ctx = makeCtx(sent, false)
      ctx.parentTranscriptPath = path
      await startTranscriptWatcher(ctx, path)
      await delay(150)

      ctx.transcriptWatcher?.stop()

      expect(types(sent)).toEqual(['user', 'queue-operation', 'assistant', 'queue-operation'])
      expect(sent[0].isInitial).toBe(true)
    })
  })
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('watcher re-point', () => {
  it('a same-file re-point keeps the offset, so nothing appended is skipped', async () => {
    // The hook fires `boot` right after onInit already started the watcher on
    // this exact path. Restarting there re-seeks to end in headless, silently
    // dropping whatever landed in between. Guarded by comparing getPath().
    await withTranscript(async path => {
      await writeFile(path, line(USER))

      const sent: Sent[] = []
      const ctx = makeCtx(sent, true)
      ctx.parentTranscriptPath = path
      await startTranscriptWatcher(ctx, path)
      await delay(150)

      const first = ctx.transcriptWatcher
      expect(first?.getPath()).toBe(path)

      // Second call for the SAME file must be a no-op, not a restart.
      await startTranscriptWatcher(ctx, path)
      expect(ctx.transcriptWatcher).toBe(first)

      await appendFile(path, line(ENQUEUE))
      await delay(400)

      ctx.transcriptWatcher?.stop()

      expect(types(sent)).toEqual(['queue-operation'])
    })
  })
})
