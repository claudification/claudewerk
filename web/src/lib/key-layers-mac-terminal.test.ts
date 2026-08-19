// Mac-platform terminal passthrough: a physical Ctrl+<key> combo inside an xterm
// is a terminal control code (Ctrl+D = EOF, Ctrl+C, ...) and must reach the PTY,
// never fire a dashboard shortcut. Cmd (mod) shortcuts still fire in the terminal.
//
// Separate file because isMac is resolved ONCE at module load -- this file mocks a
// Mac navigator before the dynamic import (key-layers.test.ts forces non-Mac).
if (typeof globalThis.KeyboardEvent === 'undefined') {
  globalThis.KeyboardEvent = class KeyboardEvent extends Event {
    readonly key: string
    readonly code: string
    readonly ctrlKey: boolean
    readonly metaKey: boolean
    readonly altKey: boolean
    readonly shiftKey: boolean
    constructor(type: string, init: KeyboardEventInit = {}) {
      super(type, init)
      this.key = init.key ?? ''
      this.code = init.code ?? ''
      this.ctrlKey = init.ctrlKey ?? false
      this.metaKey = init.metaKey ?? false
      this.altKey = init.altKey ?? false
      this.shiftKey = init.shiftKey ?? false
    }
  } as unknown as typeof KeyboardEvent
}
if (typeof globalThis.window === 'undefined') {
  const listeners: Record<string, ((...args: never[]) => unknown)[]> = {}
  globalThis.window = {
    addEventListener(type: string, fn: (...args: never[]) => unknown) {
      if (!listeners[type]) listeners[type] = []
      listeners[type].push(fn)
    },
    removeEventListener(type: string, fn: (...args: never[]) => unknown) {
      const arr = listeners[type]
      if (arr) listeners[type] = arr.filter(f => f !== fn)
    },
  } as unknown as Window & typeof globalThis
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    querySelector: () => null,
    activeElement: null,
  } as unknown as Document
}
// Force Mac platform so isMac resolves true (metaKey = mod, ctrlKey = physical Ctrl).
// defineProperty rather than assignment: under the VM pools `navigator` is an
// accessor with no setter, so `globalThis.navigator = ...` throws "which has
// only a getter" and takes the file down before a single test runs.
const realNavigator = globalThis.navigator
Object.defineProperty(globalThis, 'navigator', {
  value: {
    platform: 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  } as unknown as Navigator,
  configurable: true,
  writable: true,
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `?mac` forces a SEPARATE module instance from key-layers.test.ts's non-Mac one.
// Under `bun test` all files share one module cache, so whichever imported plain
// './key-layers' first would freeze module-level `isMac` for everyone; the query
// suffix gives this file its own evaluation that sees the Mac navigator above.
const { _test } = await import('./key-layers.ts?mac')
Object.defineProperty(globalThis, 'navigator', {
  value: realNavigator,
  configurable: true,
  writable: true,
})

const { pushLayer, popLayer, dispatch, normalizeEvent, layers, resetDoubleTap } = _test

// A fake DOM target. closest('.xterm') returns a truthy node only when `inTerm`.
function makeTarget(inTerm: boolean): Element {
  const node = {} as Element
  return {
    tagName: 'DIV',
    isContentEditable: false,
    closest: (sel: string) => (inTerm && sel === '.xterm' ? node : null),
  } as unknown as Element
}

function key(
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; code: string }> = {},
  inTerminal = false,
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods })
  Object.defineProperty(e, 'target', { value: makeTarget(inTerminal), configurable: true })
  return e
}

function clear() {
  while (layers.length > 0) popLayer(layers[0])
  resetDoubleTap()
  _test.exitChordMode() // a chord-mode test would otherwise leak activeChord into the next case
}

describe('key-layers (terminal-first keyboard, Mac)', () => {
  beforeEach(clear)
  afterEach(clear)

  it('normalizes physical Ctrl on Mac to ctrl+ (not mod+)', () => {
    expect(normalizeEvent(key('d', { ctrlKey: true }))).toBe('ctrl+d')
    expect(normalizeEvent(key('d', { metaKey: true }))).toBe('mod+d')
  })

  it('a focused terminal swallows physical Ctrl+D (EOF reaches the PTY)', () => {
    const fn = vi.fn()
    pushLayer({ 'mod+d': fn }, { base: true, id: 'cmd:open-dispatch' })

    const e = key('d', { ctrlKey: true }, /* inTerminal */ true)
    const prevented = vi.spyOn(e, 'preventDefault')
    dispatch(e)

    expect(fn).not.toHaveBeenCalled() // not stolen by the dispatcher...
    expect(prevented).not.toHaveBeenCalled() // ...and not swallowed -- xterm gets it
  })

  it('a focused terminal swallows Cmd+D too (not a captureTerminal exception)', () => {
    const fn = vi.fn()
    pushLayer({ 'mod+d': fn }, { base: true, id: 'cmd:open-dispatch' })

    const e = key('d', { metaKey: true }, /* inTerminal */ true)
    const prevented = vi.spyOn(e, 'preventDefault')
    dispatch(e)

    expect(fn).not.toHaveBeenCalled() // terminal owns it; only captureTerminal opts out
    expect(prevented).not.toHaveBeenCalled()
  })

  it('still fires the mod+d shortcut OUTSIDE a terminal (cross-match + normal dispatch intact)', () => {
    const fn = vi.fn()
    pushLayer({ 'mod+d': fn }, { base: true, id: 'cmd:open-dispatch' })

    dispatch(key('d', { ctrlKey: true }, /* inTerminal */ false)) // Ctrl cross-matches mod off-terminal
    dispatch(key('d', { metaKey: true }, /* inTerminal */ false))
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does NOT enter chord mode on Cmd+K inside a terminal (no captureTerminal chord owns it)', () => {
    pushLayer({ 'mod+k t': vi.fn() }, { base: true, id: 'cmd:some-chord' })

    dispatch(key('k', { metaKey: true }, /* inTerminal */ true))
    expect(_test.getActiveChord()).toBeNull() // Cmd+K goes to the PTY (clear scrollback / kill-line)
  })

  it('STILL enters chord mode on Cmd+K OUTSIDE a terminal', () => {
    pushLayer({ 'mod+k t': vi.fn() }, { base: true, id: 'cmd:some-chord' })

    dispatch(key('k', { metaKey: true }, /* inTerminal */ false))
    expect(_test.getActiveChord()?.prefix).toBe('mod+k')
  })

  it('a captureTerminal exception (command palette) DOES fire on Cmd+P inside a terminal', () => {
    const fn = vi.fn()
    pushLayer({ 'mod+p': fn }, { base: true, id: 'cmd:open-switcher', captureTerminal: true })

    const e = key('p', { metaKey: true }, /* inTerminal */ true)
    const prevented = vi.spyOn(e, 'preventDefault')
    dispatch(e)

    expect(fn).toHaveBeenCalledTimes(1) // the one opt-out fires...
    expect(prevented).toHaveBeenCalled() // ...and is swallowed (not sent to the PTY)
  })

  it('physical Ctrl+P does NOT trigger the Cmd-bound captureTerminal palette in a terminal', () => {
    const fn = vi.fn()
    pushLayer({ 'mod+p': fn }, { base: true, id: 'cmd:open-switcher', captureTerminal: true })

    dispatch(key('p', { ctrlKey: true }, /* inTerminal */ true)) // Ctrl+P = "previous", PTY's
    expect(fn).not.toHaveBeenCalled() // exact-match in terminal: no ctrl->mod cross-match
  })
})
