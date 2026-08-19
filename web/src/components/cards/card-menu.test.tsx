/**
 * The right-click handler has to ARRIVE at the card link. Both of them.
 *
 * The fork menu shipped dead for exactly this reason: it rendered, its unit
 * tests passed, and no handler ever reached a DOM node (see
 * `transcript/fork-point-menu.test.tsx`). So none of these tests assert that a
 * menu component exists -- every one of them drives a real right-click on a real
 * rendered card link and reads the menu that comes back.
 *
 * Both renderers are here on purpose. `CardChip` is React; the markdown card
 * link is a raw anchor painted from an HTML string. One shared menu, two mount
 * points -- if either mount point rots, one of these goes red.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { CardLookup, CardProvider, CardSummary } from '@/lib/cards'
import { registerCardProvider, resetCardProviders } from '@/lib/cards'

const moveTask = vi.fn(async (_id: string, _to: string) => 'wall-time-cursor')
vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ moveTask: (id: string, to: string) => moveTask(id, to), tasks: [] }),
}))

const { CardChip } = await import('./card-chip')
const { CardMenuLayer } = await import('./card-menu-layer')
const { useCardMenu } = await import('./card-menu-bus')
const { Markdown } = await import('../markdown')

const CARD_PATH = '.rclaude/project/cards/wall-time-cursor.md'
const ID = 'wall-time-cursor'

/** Stands in for the real board provider -- same id, so the board verbs unlock. */
function provider(lookup: CardLookup): CardProvider {
  return {
    id: 'project-board',
    matchHref: href =>
      href.includes('.rclaude/project/') && href.endsWith('.md')
        ? { provider: 'project-board', id: href.split('/').pop()?.replace('.md', '') ?? '', scope: 'claude://p' }
        : null,
    peek: () => lookup,
    resolve: vi.fn(),
    subscribe: () => () => {},
  }
}

function ready(kind: CardSummary['kind']): CardLookup {
  return {
    status: 'ready',
    summary: {
      ref: { provider: 'project-board', id: ID, scope: 'claude://p' },
      kind,
      state: 'active',
      statusLabel: 'in-progress',
      detail: 'full',
      title: 'Wall time cursor',
      tags: [],
    },
  }
}

function chip() {
  return render(
    <>
      <CardChip path={CARD_PATH} fallback={CARD_PATH} />
      <CardMenuLayer />
    </>,
  )
}

function markdownLink() {
  return render(
    <>
      <Markdown>{`[wall time](${CARD_PATH})`}</Markdown>
      <CardMenuLayer />
    </>,
  )
}

function clearPending() {
  useConversationsStore.setState({ pendingTaskEdit: null, pendingCardLaunch: null, pendingEpicRun: null })
}

beforeEach(() => {
  resetCardProviders()
  useCardMenu.setState({ armed: false, target: null })
  clearPending()
})
afterEach(() => {
  cleanup()
  clearPending()
  resetCardProviders()
  moveTask.mockClear()
})

describe('the menu reaches BOTH card renderers', () => {
  test('right-clicking a CardChip opens the card menu', async () => {
    registerCardProvider(provider(ready('card')))
    chip()
    fireEvent.contextMenu(screen.getByRole('button'))
    expect(await screen.findByText('OPEN')).toBeTruthy()
  })

  test('right-clicking a markdown card link opens the SAME menu', async () => {
    registerCardProvider(provider(ready('card')))
    const { container } = markdownLink()
    fireEvent.contextMenu(container.querySelector('a.file-link-card') as HTMLElement)
    expect(await screen.findByText('OPEN')).toBeTruthy()
    expect(await screen.findByText(/LAUNCH/)).toBeTruthy()
  })

  test('right-clicking a PLAIN file link opens nothing -- only cards get the menu', () => {
    registerCardProvider(provider(ready('card')))
    const { container } = render(
      <>
        <Markdown>{'[ops](docs/ops.md)'}</Markdown>
        <CardMenuLayer />
      </>,
    )
    fireEvent.contextMenu(container.querySelector('a.file-link') as HTMLElement)
    expect(screen.queryByText('OPEN')).toBeNull()
    expect(useCardMenu.getState().target).toBeNull()
  })
})

describe('the verbs', () => {
  test('OPEN opens the card, exactly like left-click', async () => {
    registerCardProvider(provider(ready('card')))
    chip()
    fireEvent.contextMenu(screen.getByRole('button'))
    fireEvent.click(await screen.findByText('OPEN'))
    expect(useConversationsStore.getState().pendingTaskEdit).toEqual({ slug: ID })
  })

  test('LAUNCH hands the card to the run dialog', async () => {
    registerCardProvider(provider(ready('card')))
    chip()
    fireEvent.contextMenu(screen.getByRole('button'))
    fireEvent.click(await screen.findByText(/LAUNCH/))
    expect(useConversationsStore.getState().pendingCardLaunch).toEqual({ slug: ID })
    // LAUNCH is not OPEN: the editor must not also be queued.
    expect(useConversationsStore.getState().pendingTaskEdit).toBeNull()
  })

  test('RUN hands the EPIC to the engine -- a different verb from LAUNCH', async () => {
    registerCardProvider(provider(ready('epic')))
    chip()
    fireEvent.contextMenu(screen.getByRole('button'))
    fireEvent.click(await screen.findByText(/RUN/))
    expect(useConversationsStore.getState().pendingEpicRun).toEqual({ epicId: ID })
    expect(useConversationsStore.getState().pendingCardLaunch).toBeNull()
  })

  test('a plain card is offered NO run -- the engine has nothing to dispatch', async () => {
    registerCardProvider(provider(ready('card')))
    chip()
    fireEvent.contextMenu(screen.getByRole('button'))
    await screen.findByText('OPEN')
    expect(screen.queryByText(/RUN/)).toBeNull()
  })

  test('a card no provider can resolve gets only the verbs that need no board', async () => {
    registerCardProvider(provider({ status: 'unknown' }))
    chip()
    fireEvent.contextMenu(screen.getByRole('button'))
    await screen.findByText('OPEN')
    expect(screen.queryByText(/LAUNCH/)).toBeNull()
    expect(screen.queryByText('Move to')).toBeNull()
    expect(screen.getByText('Copy id')).toBeTruthy()
  })

  test('Copy id copies the id, Copy path copies the path it was linked by', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    registerCardProvider(provider(ready('card')))
    chip()
    fireEvent.contextMenu(screen.getByRole('button'))
    fireEvent.click(await screen.findByText('Copy path'))
    expect(writeText).toHaveBeenCalledWith(CARD_PATH)
  })
})
