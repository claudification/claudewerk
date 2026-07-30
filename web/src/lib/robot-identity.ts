/**
 * ROBOT IDENTITY -- a fun, stable face + handle for one agent session.
 *
 * Every transcript entry already carries the CC session id (`ccSessionId`,
 * `TranscriptEntryBase` in src/shared/protocol.ts). Feed it here and you get
 * `CRAZY PANDA`, the seed its DiceBear face is drawn from, and the disc colour
 * behind it. Because all three are DERIVED, not stored, the browser / broker /
 * CLI arrive at the same answer without agreeing on anything -- and it survives
 * reload, resume and rebuild for free. Nothing to persist, nothing to migrate,
 * nothing that can drift.
 *
 * A session, not a conversation: a `/clear` mints a new ccSessionId, so the
 * robot CHANGES mid-transcript. That is the point -- the face is how you spot a
 * session boundary while scrolling, without reading a single timestamp.
 *
 * Cosmetic only. Never route, key, or make a decision on any of this.
 */

import type { TranscriptEntry } from '@shared/protocol'
import { ROBOT_ADJECTIVES, ROBOT_NOUNS } from './robot-words'

export interface RobotIdentity {
  /** Display handle, e.g. `CRAZY PANDA`. */
  name: string
  /** DiceBear seed -- the session id verbatim, so face and name always agree. */
  seed: string
  /** Disc colour behind the face, hex WITHOUT `#` (DiceBear's wire format). */
  backgroundColor: string
}

/** FNV-1a, 32-bit. Cheap, dependency-free, and stable across runtimes -- which
 *  matters far more here than distribution quality, because the only property
 *  we actually need is that everyone computes the SAME answer. */
function hash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Avalanche step, so successive draws don't ride correlated bits of one hash.
 *  Without it, adjacent session ids share an adjective far too often. */
function mix32(h: number): number {
  let x = h
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  return x >>> 0
}

/** HSL -> hex (no `#`). Standard sRGB conversion. */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const a = (saturation / 100) * Math.min(lightness / 100, 1 - lightness / 100)
  function channel(n: number): string {
    const k = (n + hue / 30) % 12
    const value = lightness / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * value)
      .toString(16)
      .padStart(2, '0')
  }
  return `${channel(0)}${channel(8)}${channel(4)}`
}

/**
 * The disc colour. HUE is the only thing the hash picks -- saturation and
 * lightness are FIXED, which is what makes a wall of these look like one set
 * instead of a ransom note. The pair is tuned for the dark panel: deep enough
 * that a light toon face reads against it, saturated enough to tell two robots
 * apart at 18px.
 */
function discColor(h: number): string {
  return hslToHex(h % 360, 45, 38)
}

/** Derive the stable robot handle, avatar seed and disc colour for a session id. */
export function robotIdentity(sessionId: string): RobotIdentity {
  const h = hash32(sessionId)
  const mixed = mix32(h)
  const adjective = ROBOT_ADJECTIVES[h % ROBOT_ADJECTIVES.length]
  const noun = ROBOT_NOUNS[mixed % ROBOT_NOUNS.length]
  return {
    name: `${adjective} ${noun}`,
    seed: sessionId,
    backgroundColor: discColor(mix32(mixed)),
  }
}

/**
 * The robot for one assistant group, or null when the group predates the
 * session-id field (old transcripts) -- callers fall back to the configured
 * agent label there rather than inventing a face for an unknown session.
 */
export function assistantRobot(entries: TranscriptEntry[]): RobotIdentity | null {
  const sessionId = entries.find(entry => entry.ccSessionId)?.ccSessionId
  return sessionId ? robotIdentity(sessionId) : null
}
