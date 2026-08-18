/**
 * voice-timeline - what one dictation actually cost, measured on THIS device.
 *
 * WHY IT EXISTS. The four costs in front of the first transcribed word were
 * argued from code comments and platform lore -- "getUserMedia is 2-3s cold",
 * "AudioContext is 50-300ms" -- and then quoted back as if they were readings.
 * They were not. The same mistake ran the whole voice saga: a geography problem
 * nobody measured for months. So every number here is a mark taken at the seam
 * it describes, on the machine holding the microphone, and the module has no way
 * to produce an estimate even if someone wanted one.
 *
 * THE HEADLINE IS `lostMs`, and it is the only number that answers the original
 * complaint. It is the gap from the key going down to the first sample actually
 * captured, MINUS the speech the pre-roll ring handed back. Zero means nothing
 * was lost -- not that nothing was slow.
 *
 * Marks are recorded through a module singleton rather than threaded through the
 * pipeline, because the seams span usePushToTalk -> useVoiceRecording ->
 * voice-mic-stream -> voice-preroll -> the Worker session, and a context object
 * passed through all five would be a bigger change than the thing it measures.
 * Same shape as the pre-roll graph it sits next to.
 */

/** How many dictations to keep for comparison. Enough to see a pattern. */
const HISTORY_LIMIT = 10

export interface Mark {
  phase: string
  /** Milliseconds since the key went down. */
  at: number
  detail?: string
}

export interface DictationRecord {
  id: number
  takenAt: string
  marks: Mark[]
  /** Speech handed back by the ring, and whether it actually contained any. */
  prerollMs: number
  prerollFrames: number
  prerollPeakDb: number
  micWarm: boolean
  armSync: boolean
  transport: string
  model: string
  chars: number
}

type Facts = Partial<Omit<DictationRecord, 'id' | 'takenAt' | 'marks'>>

const EMPTY_FACTS: Facts = {
  prerollMs: 0,
  prerollFrames: 0,
  prerollPeakDb: Number.NEGATIVE_INFINITY,
  micWarm: false,
  armSync: false,
  transport: '',
  model: '',
  chars: 0,
}

let current: { id: number; t0: number; takenAt: string; marks: Mark[]; facts: Facts } | null = null
let nextId = 1
const history: DictationRecord[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export function subscribeDictations(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function dictationHistory(): DictationRecord[] {
  return history
}

export function clearDictationHistory() {
  history.length = 0
  emit()
}

/** The key went down. Everything after this is measured from here. */
export function beginDictation() {
  current = {
    id: nextId++,
    t0: performance.now(),
    takenAt: new Date().toISOString(),
    marks: [{ phase: 'keydown', at: 0 }],
    facts: { ...EMPTY_FACTS },
  }
}

/**
 * Record a seam. A no-op when no dictation is open, so a pre-warm or a stray
 * teardown cannot invent a mark on the previous recording.
 */
export function mark(phase: string, detail?: string) {
  if (!current) return
  current.marks.push({ phase, at: Math.round(performance.now() - current.t0), detail })
}

/** Record something that is not a time: warm/cold, pre-roll size, char count. */
export function noteDictation(facts: Facts) {
  if (!current) return
  Object.assign(current.facts, facts)
}

/** Close the record, keep it for comparison, and hand it back. */
export function endDictation(): DictationRecord | null {
  if (!current) return null
  const record: DictationRecord = {
    id: current.id,
    takenAt: current.takenAt,
    marks: current.marks,
    ...EMPTY_FACTS,
    ...current.facts,
  } as DictationRecord
  current = null
  history.unshift(record)
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT
  emit()
  return record
}

/** Abandon the open record without keeping it -- a cancelled or aborted press. */
export function abandonDictation() {
  current = null
}

function at(record: DictationRecord, phase: string): number | null {
  return record.marks.find(m => m.phase === phase)?.at ?? null
}

/**
 * The gap from the key going down to the first sample actually captured. This is
 * the window in which speech physically cannot be recorded, whatever the UI says.
 */
export function captureGapMs(record: DictationRecord): number {
  return at(record, 'capture') ?? at(record, 'arm') ?? 0
}

/**
 * What the user actually lost: the dead window, minus what the ring handed back.
 * Never negative -- pre-roll longer than the gap means the head is fully covered,
 * not that time was gained.
 */
export function lostMs(record: DictationRecord): number {
  return Math.max(0, captureGapMs(record) - record.prerollMs)
}

/** Did the pre-roll actually contain speech, or just room tone? Answers "was
 *  anything really being lost" with a measurement instead of an opinion. */
export function prerollHadSpeech(record: DictationRecord): boolean {
  // -45 dBFS sits well above a quiet room's noise floor and well below speech at
  // any normal distance from a close-talk mic.
  return record.prerollFrames > 0 && record.prerollPeakDb > -45
}
