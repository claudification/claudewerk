/**
 * THE FILTER BOX SUGGESTS WHAT THE FLEET ACTUALLY HAS.
 *
 * The claim under test is "REAL current values, not a static set", so nothing
 * here hardcodes a list: the fleet is seeded into the conversations store and
 * every assertion reads back what that seed implies. Change the seed and the
 * expectations move with it, which is the only way this suite can be evidence
 * rather than decoration.
 *
 * The keyboard half is the other half of the card: arrow to move, Tab or Enter
 * to accept, and an Escape LADDER -- the dropdown first, then the box, then
 * ambient -- because the box's existing Escape-to-blur has to stay reachable.
 */

import { fireEvent } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { useWallFilterStore } from '@/lib/wall/filter'
import { useWallStore } from './wall-state'
import { installWallTestHooks, openTheWall, wallRoot } from './wall-test-utils'

const RC = 'claude://default/Users/j/remote-claude'
const ANVIL = 'claude://default/Users/j/anvil-md'

function conversation(id: string, over: Partial<Conversation>): Conversation {
  return {
    id,
    project: RC,
    status: 'active',
    title: id,
    lastActivity: Date.now() - 60_000,
    ...over,
  } as unknown as Conversation
}

/** A fleet with two projects, two hosts, two models and two branches -- so every
 *  sigil has more than one value and a wrong list cannot pass by accident. */
function seedFleet(): void {
  useConversationsStore.setState({
    conversationsById: {
      a: conversation('a', { project: RC, hostSentinelAlias: 'studio', model: 'opus', gitBranch: 'main' }),
      b: conversation('b', { project: ANVIL, hostSentinelAlias: 'thai', model: 'haiku', gitBranch: 'wip-slash' }),
    },
    projectSettings: {},
    projectOrder: {
      tree: [],
      workspaces: [
        { id: 'ws-eng', name: 'Engineering' },
        { id: 'ws-client', name: 'Client Work' },
      ],
      workspaceTrees: { 'ws-eng': [{ id: RC, type: 'project' }], 'ws-client': [] },
    },
  } as never)
}

installWallTestHooks()
beforeEach(() => {
  useWallFilterStore.getState().clear()
  seedFleet()
})

const filterBox = (): HTMLInputElement => {
  const input = wallRoot().querySelector('.wall-filter input')
  if (!input) throw new Error('the filter box never mounted')
  return input as HTMLInputElement
}

/** Type, carrying the caret with the text -- the caret is what picks the sigil,
 *  so a change event without one would be testing a different component. */
function type(input: HTMLInputElement, value: string, caret = value.length): void {
  fireEvent.change(input, { target: { value, selectionStart: caret } })
}

/** What the dropdown is offering, top to bottom. */
function options(): string[] {
  return [...wallRoot().querySelectorAll('.wall-filter-suggest [role="option"]')].map(el =>
    (el.textContent ?? '').slice(1),
  )
}

function selectedOption(): string | null {
  const on = wallRoot().querySelector('.wall-filter-suggest [aria-selected="true"]')
  return on ? (on.textContent ?? '').slice(1) : null
}

describe('the filter box suggests the values the fleet HAS', () => {
  it('offers live projects, tags, hosts, models and workspaces -- one sigil each', async () => {
    await openTheWall()
    const input = filterBox()

    // Every one of these lists is derived from the seed above. None of them is
    // written down anywhere in the product.
    type(input, '@')
    expect(options()).toEqual(['remote-claude', 'anvil-md'])
    type(input, '#')
    expect(options()).toEqual(['main', 'wip-slash'])
    type(input, '&')
    expect(options()).toEqual(['studio', 'thai'])
    type(input, ':')
    expect(options()).toEqual(['opus', 'haiku'])
    type(input, '^')
    expect(options()).toEqual(['Engineering', 'Client Work'])
  })

  it('follows the fleet rather than a snapshot taken at mount', async () => {
    await openTheWall()
    const input = filterBox()
    type(input, '&')
    expect(options()).toEqual(['studio', 'thai'])

    act(() => {
      useConversationsStore.setState({
        conversationsById: { c: conversation('c', { hostSentinelAlias: 'nas' }) },
      } as never)
    })
    expect(options()).toEqual(['nas'])
  })

  it('narrows as you type, and says nothing at all for free text', async () => {
    await openTheWall()
    const input = filterBox()

    type(input, '@anv')
    expect(options()).toEqual(['anvil-md'])
    type(input, '@zzz')
    expect(options()).toEqual([])
    type(input, 'ceiling')
    expect(wallRoot().querySelector('.wall-filter-suggest')).toBeNull()
  })

  it('completes the token the caret is in, mid-query', async () => {
    await openTheWall()
    const input = filterBox()
    type(input, '!! @rem ~30m', 7)
    expect(options()).toEqual(['remote-claude'])
  })
})

describe('the suggestion list is keyboard-only reachable', () => {
  it('arrows move the selection, Enter accepts it', async () => {
    await openTheWall()
    const input = filterBox()
    type(input, '@')
    expect(selectedOption()).toBe('remote-claude')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(selectedOption()).toBe('anvil-md')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(selectedOption()).toBe('remote-claude')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useWallFilterStore.getState().raw).toBe('@remote-claude ')
    expect(useWallFilterStore.getState().query.project).toBe('remote-claude')
  })

  it('Tab accepts too, the way a shell completes', async () => {
    await openTheWall()
    const input = filterBox()
    type(input, '^cl')
    // A workspace named with a space arrives hyphenated, because a bare space
    // would split the token and quietly become free text.
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(useWallFilterStore.getState().raw).toBe('^Client-Work ')
    expect(useWallFilterStore.getState().query.workspace).toBe('client-work')
  })

  it('leaves the box alone when there is nothing to accept', async () => {
    await openTheWall()
    const input = filterBox()
    type(input, 'ceiling')
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
  })
})

describe('Escape is a ladder: the list, then the box, then ambient', () => {
  it('dismisses the dropdown on the first press and keeps the caret in the box', async () => {
    await openTheWall()
    const input = filterBox()
    input.focus()
    type(input, '@')
    expect(options()).toHaveLength(2)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(wallRoot().querySelector('.wall-filter-suggest')).toBeNull()
    // Still in the box: the card's rule is that the box's own Escape stays
    // reachable with a SECOND press, not that the first one does both.
    expect(document.activeElement).toBe(input)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.activeElement).not.toBe(input)
  })

  it('revives the list on the next keystroke, so one Escape is not permanent', async () => {
    await openTheWall()
    const input = filterBox()
    input.focus()
    type(input, '@')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(options()).toEqual([])

    type(input, '@an')
    expect(options()).toEqual(['anvil-md'])
  })

  it('does not spend ambient`s Escape while a list is open', async () => {
    await openTheWall()
    const input = filterBox()
    fireEvent.keyDown(document, { key: 'a' })
    expect(useWallStore.getState().ambient).toBe(true)

    input.focus()
    type(input, '@')
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'Escape' })
    // Two presses spent on the list and the box; ambient still has to be up.
    expect(useWallStore.getState().ambient).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useWallStore.getState().ambient).toBe(false)
  })
})
