/**
 * The escalation, and its restraint.
 *
 * A toast for something you just watched finish is noise, and noise is how a
 * notification channel gets muted for good. These pin that it fires exactly
 * once, only off-screen, and only when the surface asked for it.
 */

import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useModalManagerStore } from './use-modal-manager'
import { useSurfaceCompletionToast } from './use-surface-completion-toast'

const LOUD = { id: 'vacuum', kind: 'vacuum', title: 'Vacuum', notifyOnComplete: true }
const QUIET = { id: 'quiet', kind: 'quiet', title: 'Quiet' }
const store = () => useModalManagerStore.getState()

function Watcher() {
  useSurfaceCompletionToast()
  return null
}

let toasts: CustomEvent[] = []
const collect = (e: Event) => toasts.push(e as CustomEvent)

beforeEach(() => {
  toasts = []
  useModalManagerStore.setState({ records: {} })
  window.addEventListener('rclaude-toast', collect)
  render(<Watcher />)
})
afterEach(() => {
  window.removeEventListener('rclaude-toast', collect)
  cleanup()
  vi.restoreAllMocks()
})

/** Run to completion while parked. */
function finishParked(opts: typeof LOUD | typeof QUIET, status: 'done' | 'error' = 'done') {
  act(() => {
    store().open(opts, { type: 'global' })
    store().minimize(opts.id)
    store().reportActivity(opts.id, { status: 'running', tick: 1 })
    store().reportActivity(opts.id, { status, label: 'reclaimed 3 GB' })
  })
}

it('announces a finish that happened while parked', () => {
  finishParked(LOUD)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]?.detail).toMatchObject({ title: 'Vacuum', body: 'reclaimed 3 GB', surfaceId: 'vacuum' })
})

it('sends you back to the surface that finished', () => {
  finishParked(LOUD)
  expect(toasts[0]?.detail.surfaceId).toBe('vacuum')
})

it('marks a failure as one', () => {
  finishParked(LOUD, 'error')
  expect(toasts[0]?.detail.variant).toBe('error')
})

it('stays quiet for a surface that never asked', () => {
  finishParked(QUIET)
  expect(toasts).toHaveLength(0)
})

it('stays quiet for a finish you watched happen', () => {
  act(() => {
    store().open(LOUD, { type: 'global' })
    store().reportActivity('vacuum', { status: 'running', tick: 1 })
    store().reportActivity('vacuum', { status: 'done', label: 'reclaimed 3 GB' })
  })
  expect(toasts).toHaveLength(0)
})

it('announces once, not on every later report', () => {
  finishParked(LOUD)
  act(() => {
    store().reportActivity('vacuum', { status: 'done', label: 'reclaimed 3 GB', tick: 9 })
  })
  expect(toasts).toHaveLength(1)
})
