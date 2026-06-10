const TRAFFIC_WINDOW_MS = 3000
const MAX_TRAFFIC_SAMPLES = 4000

export interface TrafficTracker {
  recordTraffic: (direction: 'in' | 'out', bytes: number) => void
  getTrafficStats: () => {
    in: { messagesPerSec: number; bytesPerSec: number }
    out: { messagesPerSec: number; bytesPerSec: number }
  }
}

export function createTrafficTracker(): TrafficTracker {
  // Circular ring buffer: O(1) push + O(1) prune (advance head), no Array.shift().
  const buf = new Array<{ t: number; dir: 'in' | 'out'; bytes: number }>(MAX_TRAFFIC_SAMPLES)
  let head = 0 // index of oldest entry
  let tail = 0 // index where next entry goes
  let size = 0

  function push(sample: { t: number; dir: 'in' | 'out'; bytes: number }): void {
    buf[tail] = sample
    tail = (tail + 1) % MAX_TRAFFIC_SAMPLES
    if (size < MAX_TRAFFIC_SAMPLES) {
      size++
    } else {
      // Buffer full: overwrite oldest, advance head
      head = (head + 1) % MAX_TRAFFIC_SAMPLES
    }
  }

  function prune(): void {
    const cutoff = Date.now() - TRAFFIC_WINDOW_MS
    while (size > 0 && (buf[head] as { t: number }).t < cutoff) {
      head = (head + 1) % MAX_TRAFFIC_SAMPLES
      size--
    }
  }

  return {
    recordTraffic(direction, bytes) {
      push({ t: Date.now(), dir: direction, bytes })
      prune()
    },

    getTrafficStats() {
      prune()
      const windowSec = TRAFFIC_WINDOW_MS / 1000
      let inMsgs = 0
      let inBytes = 0
      let outMsgs = 0
      let outBytes = 0
      for (let i = 0; i < size; i++) {
        const s = buf[(head + i) % MAX_TRAFFIC_SAMPLES] as { t: number; dir: 'in' | 'out'; bytes: number }
        if (s.dir === 'in') {
          inMsgs++
          inBytes += s.bytes
        } else {
          outMsgs++
          outBytes += s.bytes
        }
      }
      return {
        in: { messagesPerSec: +(inMsgs / windowSec).toFixed(1), bytesPerSec: Math.round(inBytes / windowSec) },
        out: { messagesPerSec: +(outMsgs / windowSec).toFixed(1), bytesPerSec: Math.round(outBytes / windowSec) },
      }
    },
  }
}
