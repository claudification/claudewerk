import { describe, expect, test } from 'bun:test'
import type { Conversation, DialogSnapshot } from '../../../shared/protocol'
import { clearPendingAttention } from './permission'

/**
 * THE 2026-08-19 SILENT-ROT BUG.
 *
 * `mcp__rclaude__dialog` returns the INSTANT the dialog is shown (measured at
 * 44 ms) -- the dialog stays open on screen and the answer comes back later as a
 * separate channel message. So its own `PostToolUse` fires ~200 ms after
 * `dialog_show`, and `PostToolUse` used to call `clearPendingAttention`
 * unconditionally, deleting the attention flag that `dialog_show` had just set.
 *
 * Live trace (conversation 88739d3a, "bug: soundsource port leak"):
 *
 *   [88739d3a] PreToolUse (mcp__rclaude__dialog)
 *   [88739d3a] [dialog] Show: "SoundSource A/B test..." (8bfbeb70)
 *   [88739d3a] PostToolUse (mcp__rclaude__dialog)      <- 213 ms later
 *
 * The dialog then sat open for ~12 minutes with the conversation reporting that
 * it needed nothing: absent from Pulse's attention band, absent from every
 * "who is waiting on me" surface.
 *
 * The rule these tests pin: `clearPendingAttention` may only clear attention
 * that is DEAD. A `dialog`-type attention whose dialog is still open outlives
 * the tool call, and only the dialog's own lifecycle owners retire it --
 * `clearDialogState` (handlers/dialog.ts) on answer/cancel/dismiss, and
 * dialog-live.ts on a non-open snapshot.
 */

function conv(over: Partial<Conversation>): Conversation {
  return { id: 'c1', project: 'claude://default/tmp', ...over } as unknown as Conversation
}

const DIALOG_ATTENTION = { type: 'dialog', question: 'A/B test', timestamp: 1 } as const

function snapshot(status: DialogSnapshot['status']): Conversation['liveDialog'] {
  return { dialogId: 'd1', snapshot: { dialogId: 'd1', status, seq: 0 } as DialogSnapshot, updatedAt: 1 }
}

describe('clearPendingAttention', () => {
  test('keeps a dialog attention while the one-shot dialog is still open', () => {
    const c = conv({
      pendingAttention: { ...DIALOG_ATTENTION },
      pendingDialog: { dialogId: 'd1', layout: {} as never, timestamp: 1 },
    })

    clearPendingAttention(c)

    expect(c.pendingAttention?.type).toBe('dialog')
  })

  test('keeps a dialog attention while a persistent dialog is open', () => {
    const c = conv({ pendingAttention: { ...DIALOG_ATTENTION }, liveDialog: snapshot('open') })

    clearPendingAttention(c)

    expect(c.pendingAttention?.type).toBe('dialog')
  })

  test('clears a dialog attention once the persistent dialog is no longer open', () => {
    const c = conv({ pendingAttention: { ...DIALOG_ATTENTION }, liveDialog: snapshot('closed') })

    clearPendingAttention(c)

    expect(c.pendingAttention).toBeUndefined()
  })

  test('clears a dialog attention orphaned by a vanished dialog', () => {
    const c = conv({ pendingAttention: { ...DIALOG_ATTENTION } })

    clearPendingAttention(c)

    expect(c.pendingAttention).toBeUndefined()
  })

  test('an open dialog does not shield an unrelated attention type', () => {
    const c = conv({
      pendingAttention: { type: 'permission', toolName: 'Bash', timestamp: 1 },
      pendingDialog: { dialogId: 'd1', layout: {} as never, timestamp: 1 },
    })

    clearPendingAttention(c)

    expect(c.pendingAttention).toBeUndefined()
  })

  test('still clears the permission + ask payloads it owns', () => {
    const c = conv({
      pendingAttention: { ...DIALOG_ATTENTION },
      pendingDialog: { dialogId: 'd1', layout: {} as never, timestamp: 1 },
      pendingPermission: { requestId: 'r1', toolName: 'Bash', description: '', inputPreview: '', timestamp: 1 },
      pendingAskQuestion: { toolUseId: 't1', questions: [], timestamp: 1 },
    })

    clearPendingAttention(c)

    expect(c.pendingPermission).toBeUndefined()
    expect(c.pendingAskQuestion).toBeUndefined()
  })
})
