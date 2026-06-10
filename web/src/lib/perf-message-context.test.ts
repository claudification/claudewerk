import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetMessageContext,
  beginMessage,
  currentMessageTag,
  endMessage,
  setFlushBatch,
} from './perf-message-context'
import { clearEntries, getEntries, messageImpactStats, type PerfEntry, record, setPerfEnabled } from './perf-metrics'

describe('perf-message-context', () => {
  beforeEach(() => {
    _resetMessageContext()
  })

  it('returns undefined with no active span or batch', () => {
    expect(currentMessageTag()).toBeUndefined()
  })

  it('a live sync span takes precedence over the batch tag', () => {
    setFlushBatch('transcript_entriesx3')
    expect(currentMessageTag()).toBe('transcript_entriesx3')
    beginMessage('status_update')
    expect(currentMessageTag()).toBe('status_update')
    endMessage()
    // falls back to the batch tag once the span closes
    expect(currentMessageTag()).toBe('transcript_entriesx3')
  })
})

describe('record() msgType stamping', () => {
  beforeEach(() => {
    _resetMessageContext()
    setPerfEnabled(true)
    clearEntries()
  })
  afterEach(() => {
    setPerfEnabled(false)
    clearEntries()
  })

  it('stamps the active tag onto recorded entries', () => {
    beginMessage('transcript_entries')
    record('message', 'apply:transcript_entries', 4)
    endMessage()
    record('render', 'Transcript', 8) // no tag
    const entries = getEntries()
    expect(entries[0]?.msgType).toBe('transcript_entries')
    expect(entries[1]?.msgType).toBeUndefined()
  })
})

describe('messageImpactStats', () => {
  const mk = (category: PerfEntry['category'], label: string, durationMs: number, msgType?: string): PerfEntry => ({
    t: 0,
    category,
    label,
    durationMs,
    msgType,
  })

  it('rolls apply / render / paint / grouping up per message type', () => {
    const entries: PerfEntry[] = [
      mk('message', 'apply:transcript_entries', 4, 'transcript_entries'),
      mk('message', 'apply:transcript_entries', 2, 'transcript_entries'),
      mk('render', 'Transcript', 10, 'transcript_entries'),
      mk('render', 'Transcript.commit->paint', 6, 'transcript_entries'),
      mk('grouping', 'group', 3, 'transcript_entries'),
      mk('message', 'apply:status_update', 1, 'status_update'),
    ]
    const rows = messageImpactStats(entries)
    const te = rows.find(r => r.msgType === 'transcript_entries')
    expect(te).toBeDefined()
    expect(te?.applies).toBe(2)
    expect(te?.applyMs).toBe(6)
    expect(te?.renderMs).toBe(10)
    expect(te?.paintMs).toBe(6)
    expect(te?.groupingMs).toBe(3)
    expect(te?.totalMs).toBe(25)
    // heaviest first
    expect(rows[0]?.msgType).toBe('transcript_entries')
  })

  it('ignores untagged entries and tab-hidden artifacts', () => {
    const entries: PerfEntry[] = [
      mk('render', 'X', 5), // untagged
      { ...mk('render', 'X.commit->paint', 9000, 'transcript_entries'), detail: 'update suspended(tab-hidden)' },
    ]
    expect(messageImpactStats(entries)).toEqual([])
  })
})
