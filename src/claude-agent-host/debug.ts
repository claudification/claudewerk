import { appendFileSync } from 'node:fs'
import { secureTmpPath } from '../shared/secure-temp'

export const DEBUG = !!process.env.RCLAUDE_DEBUG

// Resolved lazily: the secure-temp default mkdir's a 0700 dir, which we only
// want to pay for if debug logging is actually on (DEBUG gates every write).
let debugLogPath: string | null = null
function resolveDebugLog(): string {
  if (!debugLogPath) debugLogPath = process.env.RCLAUDE_DEBUG_LOG || secureTmpPath('rclaude-debug.log')
  return debugLogPath
}

// In headless mode, debug can safely go to stderr (no PTY to corrupt)
let useStderr = false

export function setDebugStderr(enabled: boolean) {
  useStderr = enabled
}

/**
 * Debug logging -- writes to file in PTY mode, stderr in headless mode.
 * PTY mode: console output would corrupt the terminal display.
 * Headless mode: no PTY, stderr is safe and more convenient.
 */
export function debug(msg: string) {
  if (!DEBUG) return
  const line = `[${new Date().toISOString()}] ${msg}`
  if (useStderr) {
    process.stderr.write(`${line}\n`)
  }
  try {
    appendFileSync(resolveDebugLog(), `${line}\n`)
  } catch {}
}
