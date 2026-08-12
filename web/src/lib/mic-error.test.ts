/**
 * Regression tests for describeMicError.
 *
 * THE INCIDENT (2026-08-12, iPad): voice died on an iPad and the banner showed
 * WebKit's raw DOMException prose -- "The request is not allowed by the user
 * agent or the platform in the current context, possibly because the user
 * denied permission." That sentence tells the user nothing actionable, and it
 * cost a full remote-debugging session to establish it meant "iPadOS dropped
 * the mic grant on reload and the standalone Home Screen web app can't
 * re-prompt". Every mic failure must read as an instruction, not a spec quote.
 */

import { afterEach, describe, expect, test } from 'vitest'
import { describeMicError } from './mic-error'

/** A DOMException-alike: what getUserMedia actually rejects with. */
function micError(name: string): Error {
  const err = new Error('The request is not allowed by the user agent or the platform in the current context.')
  err.name = name
  return err
}

function setStandalone(standalone: boolean, touchPoints: number) {
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: standalone })
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: touchPoints })
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'standalone')
})

describe('describeMicError', () => {
  test('never leaks the raw WebKit DOMException sentence', () => {
    setStandalone(false, 0)
    expect(describeMicError(micError('NotAllowedError'))).not.toMatch(/user agent or the platform/i)
  })

  test('NotAllowedError in a touch standalone PWA names the Home Screen trap', () => {
    setStandalone(true, 5)
    const msg = describeMicError(micError('NotAllowedError'))
    expect(msg).toMatch(/safari/i)
    expect(msg.length).toBeLessThan(120)
  })

  test('NotAllowedError in a normal browser tab gives the plain permission hint', () => {
    setStandalone(false, 0)
    const msg = describeMicError(micError('NotAllowedError'))
    expect(msg).toMatch(/permission|blocked|allow/i)
    expect(msg).not.toMatch(/home screen/i)
  })

  test('maps the rest of the getUserMedia rejection family', () => {
    setStandalone(false, 0)
    expect(describeMicError(micError('NotFoundError'))).toMatch(/no microphone/i)
    expect(describeMicError(micError('NotReadableError'))).toMatch(/in use|another app/i)
    expect(describeMicError(micError('OverconstrainedError'))).toMatch(/microphone/i)
    expect(describeMicError(micError('AbortError'))).toMatch(/microphone/i)
  })

  test('passes a plain Error message through -- the acquire timeout keeps its own words', () => {
    expect(describeMicError(new Error('Microphone timed out. Try again.'))).toBe('Microphone timed out. Try again.')
  })

  test('falls back to something honest for a non-Error throw', () => {
    expect(describeMicError('kaboom')).toMatch(/microphone/i)
    expect(describeMicError(undefined)).toMatch(/microphone/i)
  })
})
