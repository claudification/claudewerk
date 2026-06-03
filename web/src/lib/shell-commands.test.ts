/**
 * Tests for shell-commands.ts -- the pure helpers (id/title/path derivation)
 * and the wire senders (with wsSend mocked to assert the exact `shell_*`
 * payloads the broker contract expects).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const wsSend = vi.fn((..._args: unknown[]) => true)
vi.mock('@/hooks/use-conversations', () => ({ wsSend: (...a: unknown[]) => wsSend(...a) }))

import {
  basename,
  closeShell,
  generateShellId,
  inputShell,
  openShell,
  resizeShell,
  shellDisplayPath,
  shellLightClass,
  shellTitle,
  subscribeShell,
  unsubscribeShell,
} from './shell-commands'

beforeEach(() => wsSend.mockClear())

describe('pure helpers', () => {
  it('generateShellId is sh_-prefixed and unique-ish', () => {
    const a = generateShellId()
    const b = generateShellId()
    expect(a).toMatch(/^sh_[a-z0-9]{10}$/)
    expect(a).not.toBe(b)
  })

  it('basename returns the last path segment, trimming trailing slashes', () => {
    expect(basename('/Users/j/proj')).toBe('proj')
    expect(basename('/Users/j/proj/')).toBe('proj')
    expect(basename('proj')).toBe('proj')
    expect(basename('')).toBe('')
    expect(basename(undefined)).toBe('')
  })

  it('shellTitle prefers explicit title, then basename, then short id', () => {
    expect(shellTitle({ title: 'My Shell', path: '/a/b', shellId: 'sh_xyz' })).toBe('My Shell')
    expect(shellTitle({ title: '  ', path: '/a/b', shellId: 'sh_xyz' })).toBe('b')
    expect(shellTitle({ title: '', path: '', shellId: 'sh_abcdef12345' })).toBe('sh_abcde')
  })

  it('shellDisplayPath falls back from path to the URI path', () => {
    expect(shellDisplayPath({ path: '/Users/j/proj', projectUri: 'claude://mac/x' })).toBe('/Users/j/proj')
    expect(shellDisplayPath({ path: '', projectUri: 'claude:///Users/j/proj' })).toBe('/Users/j/proj')
  })

  it('shellLightClass follows the flash > subscribed > history > idle precedence', () => {
    // flash wins over everything
    expect(shellLightClass(true, true, true)).toBe('bg-amber-300')
    // subscribed (watching) when not flashing
    expect(shellLightClass(false, true, true)).toBe('bg-emerald-500/60')
    // idle with history (minimized, has emitted before)
    expect(shellLightClass(false, false, true)).toBe('bg-amber-500/50')
    // never emitted
    expect(shellLightClass(false, false, false)).toBe('bg-white/20')
  })
})

describe('wire senders', () => {
  it('openShell sends shell_open with a generated id and returns it', () => {
    const id = openShell({ projectUri: 'claude://mac/p', cols: 80, rows: 24, conversationId: 'conv_1' })
    expect(id).toMatch(/^sh_/)
    expect(wsSend).toHaveBeenCalledWith('shell_open', {
      projectUri: 'claude://mac/p',
      shellId: id,
      cols: 80,
      rows: 24,
      conversationId: 'conv_1',
    })
  })

  it('openShell honors an explicit shellId and omits optional fields when absent', () => {
    const id = openShell({ projectUri: 'claude://mac/p', cols: 100, rows: 30, shellId: 'sh_fixed' })
    expect(id).toBe('sh_fixed')
    expect(wsSend).toHaveBeenCalledWith('shell_open', {
      projectUri: 'claude://mac/p',
      shellId: 'sh_fixed',
      cols: 100,
      rows: 30,
    })
  })

  it('subscribe / unsubscribe / input / resize / close map to their wire types', () => {
    subscribeShell('sh_a', 120, 40)
    expect(wsSend).toHaveBeenLastCalledWith('shell_subscribe', { shellId: 'sh_a', cols: 120, rows: 40 })
    unsubscribeShell('sh_a')
    expect(wsSend).toHaveBeenLastCalledWith('shell_unsubscribe', { shellId: 'sh_a' })
    inputShell('sh_a', 'ls\r')
    expect(wsSend).toHaveBeenLastCalledWith('shell_input', { shellId: 'sh_a', data: 'ls\r' })
    resizeShell('sh_a', 90, 25)
    expect(wsSend).toHaveBeenLastCalledWith('shell_resize', { shellId: 'sh_a', cols: 90, rows: 25 })
    closeShell('sh_a')
    expect(wsSend).toHaveBeenLastCalledWith('shell_close', { shellId: 'sh_a' })
  })
})
