/**
 * Persistent message queue: stores messages for offline/disconnected sessions.
 *
 * Keyed by target project (not session/wrapper ID) so messages survive
 * session restarts. Persisted to disk. Auto-purges expired messages.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface QueuedMessage {
  ts: number
  senderProject: string
  senderName: string
  message: Record<string, unknown> // the delivery payload
  targetName?: string // session name slug for compound-addressed delivery
}

// targetProject -> queued messages
type QueueMap = Record<string, QueuedMessage[]>

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const MAX_QUEUE_PER_TARGET = 100

let filePath = ''
let queues: QueueMap = {}
let dirty = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

export function initMessageQueue(cacheDir: string): void {
  filePath = join(cacheDir, 'message-queue.json')
  mkdirSync(dirname(filePath), { recursive: true })
  if (existsSync(filePath)) {
    try {
      queues = JSON.parse(readFileSync(filePath, 'utf-8'))
      // Backward compat: migrate legacy fromCwd/fromProject -> senderProject/senderName
      for (const msgs of Object.values(queues)) {
        for (const m of msgs) {
          const legacy = m as unknown as Record<string, unknown>
          if ('fromCwd' in legacy && !('senderProject' in legacy)) {
            legacy.senderProject = legacy.fromCwd
            delete legacy.fromCwd
          }
          if ('fromProject' in legacy && !('senderName' in legacy)) {
            legacy.senderName = legacy.fromProject
            delete legacy.fromProject
          }
        }
      }
      // Purge expired on load
      purgeExpired()
    } catch {
      queues = {}
    }
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  dirty = true
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (dirty && filePath) {
      writeFileSync(filePath, JSON.stringify(queues))
      dirty = false
    }
  }, 1000)
}

function purgeExpired(): void {
  const now = Date.now()
  let changed = false
  for (const [project, messages] of Object.entries(queues)) {
    const before = messages.length
    queues[project] = messages.filter(m => now - m.ts < MESSAGE_TTL_MS)
    if (queues[project].length === 0) {
      delete queues[project]
      changed = true
    } else if (queues[project].length !== before) {
      changed = true
    }
  }
  if (changed) scheduleSave()
}

/** Queue a message for delivery when the target project's session connects. */
export function enqueue(
  targetProject: string,
  senderProject: string,
  senderName: string,
  message: Record<string, unknown>,
  targetName?: string,
): void {
  if (!queues[targetProject]) queues[targetProject] = []
  const queue = queues[targetProject]

  // Cap queue size per target
  if (queue.length >= MAX_QUEUE_PER_TARGET) {
    queue.shift() // drop oldest
  }

  queue.push({ ts: Date.now(), senderProject, senderName, message, ...(targetName ? { targetName } : {}) })
  scheduleSave()
}

/**
 * Drain pending messages for a target project. Purges expired. Returns messages in order.
 * If sessionName is provided, only drains messages targeted at that session name
 * (or messages with no targetName -- project-level messages). Messages targeted at
 * other session names stay in the queue.
 */
export function drain(targetProject: string, sessionName?: string): QueuedMessage[] {
  const queue = queues[targetProject]
  if (!queue || queue.length === 0) return []

  const now = Date.now()
  const valid = queue.filter(m => now - m.ts < MESSAGE_TTL_MS)

  if (!sessionName) {
    // No session name filter -- drain everything (backward compat)
    delete queues[targetProject]
    scheduleSave()
    return valid
  }

  // Partition: take messages for this session (or project-level), leave the rest
  const forMe: QueuedMessage[] = []
  const forOthers: QueuedMessage[] = []
  for (const m of valid) {
    if (!m.targetName || m.targetName === sessionName) {
      forMe.push(m)
    } else {
      forOthers.push(m)
    }
  }

  if (forOthers.length === 0) {
    delete queues[targetProject]
  } else {
    queues[targetProject] = forOthers
  }
  scheduleSave()
  return forMe
}

/** Check how many messages are queued for a target project. */
export function getQueueSize(targetProject: string): number {
  return queues[targetProject]?.length || 0
}

/** Get total queue stats (for diagnostics). */
export function getQueueStats(): { targets: number; messages: number } {
  let messages = 0
  for (const queue of Object.values(queues)) {
    messages += queue.length
  }
  return { targets: Object.keys(queues).length, messages }
}
