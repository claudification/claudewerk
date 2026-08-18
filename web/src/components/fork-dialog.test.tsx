/**
 * The checkbox as the user meets it: pre-ticked for a conversation nobody has
 * touched in half an hour, untouched for one that is still moving. The default
 * is destructive, so it is asserted at the rendered-DOM level, not just in the
 * pure helper.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/lib/types'
import { ForkDialog } from './fork-dialog'
import { forkDialogBus } from './fork-dialog-trigger'

const storeState = {
  conversationsById: {} as Record<string, Conversation>,
  selectConversation: vi.fn(),
  terminateConversation: vi.fn(),
}

vi.mock('@/hooks/use-conversations', () => {
  const useConversationsStore = (selector: (s: typeof storeState) => unknown) => selector(storeState)
  useConversationsStore.getState = () => storeState
  return { useConversationsStore }
})
vi.mock('@/hooks/use-spawn', () => ({ sendSpawnRequest: vi.fn() }))

const MIN = 60_000

function source(patch: Partial<Conversation>): Conversation {
  return {
    id: 'conv_source',
    project: 'claude://default/Users/jonas/projects/repo',
    status: 'idle',
    lastActivity: 0,
    ...patch,
  } as Conversation
}

async function openWith(conversation: Conversation) {
  storeState.conversationsById = { [conversation.id]: conversation }
  render(<ForkDialog />)
  forkDialogBus.open({ conversationId: conversation.id })
  await screen.findByText('FORK CONVERSATION')
}

/** jest-dom matchers are not installed here, so assert on the DOM property. */
const closeBox = () => screen.queryByRole('checkbox', { name: 'Close the original conversation' })

describe('ForkDialog -- close the original', () => {
  beforeEach(() => {
    storeState.conversationsById = {}
  })
  afterEach(cleanup)

  it('is pre-ticked for a conversation quiet for 30+ minutes', async () => {
    await openWith(source({ lastActivity: Date.now() - 45 * MIN }))
    expect((closeBox() as HTMLInputElement).checked).toBe(true)
  })

  it('is unticked when the conversation moved inside the window', async () => {
    await openWith(source({ lastActivity: Date.now() - 3 * MIN }))
    expect((closeBox() as HTMLInputElement).checked).toBe(false)
  })

  it('is unticked while the conversation is actively working', async () => {
    await openWith(source({ status: 'active', lastActivity: 0 }))
    expect((closeBox() as HTMLInputElement).checked).toBe(false)
  })

  it('is absent for an already-ended conversation', async () => {
    await openWith(source({ status: 'ended', lastActivity: 0 }))
    expect(closeBox()).toBeNull()
  })
})
