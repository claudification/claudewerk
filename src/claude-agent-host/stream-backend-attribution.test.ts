import { describe, expect, test } from 'bun:test'
import type { TranscriptEntry } from '../shared/protocol'
import { buildStreamProcess } from './stream-backend'

/** Drive sendUserMessage with fakes: capture what hits stdin and the emitted
 *  transcript entry. proc is never touched by sendUserMessage. */
function harness() {
  const stdin: Record<string, unknown>[] = []
  const entries: TranscriptEntry[] = []
  const options = {
    conversationId: 'conv_1',
    syntheticUserUuids: new Map<string, string>(),
    onTranscriptEntries: (e: TranscriptEntry[]) => entries.push(...e),
  }
  // biome-ignore lint/suspicious/noExplicitAny: fakes for a unit test
  const sp = buildStreamProcess({} as any, j => stdin.push(j), options as any, new Map(), new Map())
  return { sp, stdin, entries }
}

describe('sendUserMessage attribution (poses as user, renders from <server>)', () => {
  test('plain message: raw stdin, no origin on the entry', () => {
    const { sp, stdin, entries } = harness()
    sp.sendUserMessage('retry the deploy')
    expect((stdin[0].message as { content: string }).content).toBe('retry the deploy')
    expect((entries[0] as { origin?: unknown }).origin).toBeUndefined()
  })

  test('attributed message: stdin stays RAW (model acts as user), entry carries origin', () => {
    const { sp, stdin, entries } = harness()
    sp.sendUserMessage('retry the deploy', { origin: { kind: 'channel', server: 'Orb' } })
    // The model must see the plain words, never a wrapper -- it poses as the user.
    expect((stdin[0].message as { content: string }).content).toBe('retry the deploy')
    // The transcript entry is what renders the "from Orb" badge.
    expect((entries[0] as { origin?: unknown }).origin).toEqual({ kind: 'channel', server: 'Orb' })
  })
})
