import type { DialogLayout } from '@shared/dialog-schema'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { LiveDialogEntry } from '@/hooks/use-live-dialogs'
import { DEFAULT_PERMISSIONS } from '@/lib/permissions'
import { PersistentDialog } from './persistent-dialog'

const layout: DialogLayout = { title: 'Refine', body: [{ type: 'TextInput', id: 'note', label: 'Note' }] }

function entry(over: Partial<LiveDialogEntry> & { rev: number }): LiveDialogEntry {
  return {
    conversationId: 'c1',
    dialogId: 'd1',
    snapshot: { dialogId: 'd1', layout, state: {}, seq: over.rev, status: 'open' },
    lastOps: [],
    replay: false,
    ...over,
  }
}

const sent: unknown[] = []

beforeEach(() => {
  sent.length = 0
  useConversationsStore.setState({
    ws: { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) } as unknown as WebSocket,
    conversationsById: { c1: { id: 'c1', status: 'idle' } } as never,
    conversationPermissions: {},
    permissions: { ...DEFAULT_PERMISSIONS },
  })
})
afterEach(cleanup)

describe('PersistentDialog', () => {
  it('emits one __submit__ dialog_event and shows the wait bar', () => {
    render(<PersistentDialog conversationId="c1" entry={entry({ rev: 1 })} />)
    fireEvent.click(screen.getByRole('button', { name: /send to agent/i }))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'dialog_event', handlerId: '__submit__', on: 'submit' })
    expect(screen.getByText(/waiting for the agent/i)).toBeTruthy()
  })

  it('clears the wait bar when a patch (new rev) lands', () => {
    const { rerender } = render(<PersistentDialog conversationId="c1" entry={entry({ rev: 1 })} />)
    fireEvent.click(screen.getByRole('button', { name: /send to agent/i }))
    expect(screen.queryByText(/waiting for the agent/i)).toBeTruthy()
    rerender(<PersistentDialog conversationId="c1" entry={entry({ rev: 2, lastOps: [] })} />)
    expect(screen.queryByText(/waiting for the agent/i)).toBeNull()
  })

  it('surfaces a broker rejection as a recoverable error', () => {
    const { rerender } = render(<PersistentDialog conversationId="c1" entry={entry({ rev: 1 })} />)
    fireEvent.click(screen.getByRole('button', { name: /send to agent/i }))
    rerender(<PersistentDialog conversationId="c1" entry={entry({ rev: 2, error: 'rate_limited' })} />)
    expect(screen.getByText(/send failed: rate_limited/i)).toBeTruthy()
    expect(screen.queryByText(/waiting for the agent/i)).toBeNull()
  })

  it('is read-only without dialog:interact permission', () => {
    useConversationsStore.setState({ permissions: { ...DEFAULT_PERMISSIONS, canDialogInteract: false } })
    render(<PersistentDialog conversationId="c1" entry={entry({ rev: 1 })} />)
    expect(screen.getByText(/read-only access/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /send to agent/i })).toBeNull()
  })
})
