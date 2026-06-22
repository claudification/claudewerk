import { describe, expect, it } from 'bun:test'
import { dialogPrincipal, guardDialogEvent, hasDialogInteract } from './dialog-interact-guard'
import { MAX_EVENT_STATE_BYTES } from './dialog-live-store'
import type { WsData } from './handler-context'

const DEFAULT_SHARE_PERMS = ['chat', 'chat:read', 'files:read', 'terminal:read']

const liveOpen = { dialogId: 'd1', snapshot: { status: 'open' } }

function base(over: Partial<WsData> = {}): WsData {
  return { isControlPanel: true, ...over }
}

describe('hasDialogInteract', () => {
  it('admin role -> allowed', () => {
    expect(hasDialogInteract(base({ grants: [{ scope: '*', roles: ['admin'] }] }), '*')).toBe(true)
  })

  it('explicit dialog:interact permission -> allowed', () => {
    expect(hasDialogInteract(base({ grants: [{ scope: '*', permissions: ['dialog:interact'] }] }), '*')).toBe(true)
  })

  it('chat permission alone does NOT grant dialog:interact (R2#1 — chat not reused)', () => {
    expect(hasDialogInteract(base({ grants: [{ scope: '*', permissions: ['chat', 'chat:read'] }] }), '*')).toBe(false)
  })

  it('default share grants (chat included) are read-only on dialogs', () => {
    const share = base({
      isControlPanel: false,
      isShare: true,
      shareToken: 'tok123456',
      grants: [{ scope: '*', permissions: DEFAULT_SHARE_PERMS as never }],
    })
    expect(hasDialogInteract(share, '*')).toBe(false)
  })

  it('no-grants connection is a trusted bearer (allowed) but a no-grants share is denied', () => {
    expect(hasDialogInteract(base({ grants: undefined }), '*')).toBe(true)
    expect(hasDialogInteract(base({ isControlPanel: false, isShare: true, grants: undefined }), '*')).toBe(false)
  })
})

describe('guardDialogEvent', () => {
  const okData = base({ userName: 'jonas', grants: [{ scope: '*', roles: ['admin'] }] })

  it('rejects when the principal lacks dialog:interact', () => {
    const r = guardDialogEvent({
      data: base({ grants: [{ scope: '*', permissions: ['chat'] }] }),
      project: '*',
      liveDialog: liveOpen,
      dialogId: 'd1',
      handlerId: 'h',
      state: {},
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('permission')
  })

  it('rejects when there is no live dialog / wrong dialog / not open', () => {
    expect(
      guardDialogEvent({
        data: okData,
        project: '*',
        liveDialog: undefined,
        dialogId: 'd1',
        handlerId: 'h',
        state: {},
      }),
    ).toMatchObject({ ok: false, reason: 'no_dialog' })
    expect(
      guardDialogEvent({ data: okData, project: '*', liveDialog: liveOpen, dialogId: 'dX', handlerId: 'h', state: {} }),
    ).toMatchObject({ ok: false, reason: 'wrong_dialog' })
    expect(
      guardDialogEvent({
        data: okData,
        project: '*',
        liveDialog: { dialogId: 'd1', snapshot: { status: 'closed' } },
        dialogId: 'd1',
        handlerId: 'h',
        state: {},
      }),
    ).toMatchObject({ ok: false, reason: 'not_open' })
  })

  it('rejects forged/empty handler ids but allows reserved markers', () => {
    expect(
      guardDialogEvent({ data: okData, project: '*', liveDialog: liveOpen, dialogId: 'd1', handlerId: '', state: {} }),
    ).toMatchObject({ ok: false, reason: 'bad_handler' })
    expect(
      guardDialogEvent({
        data: okData,
        project: '*',
        liveDialog: liveOpen,
        dialogId: 'd1',
        handlerId: '_x',
        state: {},
      }),
    ).toMatchObject({ ok: false, reason: 'bad_handler' })
    expect(
      guardDialogEvent({
        data: okData,
        project: '*',
        liveDialog: liveOpen,
        dialogId: 'd1',
        handlerId: '__submit__',
        state: {},
      }),
    ).toMatchObject({ ok: true })
  })

  it('rejects oversized state', () => {
    const r = guardDialogEvent({
      data: okData,
      project: '*',
      liveDialog: liveOpen,
      dialogId: 'd1',
      handlerId: 'h',
      state: { blob: 'x'.repeat(MAX_EVENT_STATE_BYTES + 1) },
    })
    expect(r).toMatchObject({ ok: false, reason: 'too_large' })
  })

  it('enforces the single-interactor lock (other principals read-only)', () => {
    const locked = { dialogId: 'd1', snapshot: { status: 'open' }, interactor: 'someone-else' }
    expect(
      guardDialogEvent({ data: okData, project: '*', liveDialog: locked, dialogId: 'd1', handlerId: 'h', state: {} }),
    ).toMatchObject({ ok: false, reason: 'locked' })
    // The lock holder is allowed.
    const ownData = base({ userName: 'someone-else', grants: [{ scope: '*', roles: ['admin'] }] })
    expect(
      guardDialogEvent({ data: ownData, project: '*', liveDialog: locked, dialogId: 'd1', handlerId: 'h', state: {} }),
    ).toMatchObject({ ok: true, principal: 'someone-else' })
  })

  it('returns the resolved principal on success', () => {
    const r = guardDialogEvent({
      data: okData,
      project: '*',
      liveDialog: liveOpen,
      dialogId: 'd1',
      handlerId: 'h',
      state: {},
    })
    expect(r).toEqual({ ok: true, principal: 'jonas' })
  })
})

describe('dialogPrincipal', () => {
  it('prefers userName, then share token, then bearer', () => {
    expect(dialogPrincipal(base({ userName: 'jonas' }))).toBe('jonas')
    expect(dialogPrincipal(base({ isControlPanel: false, shareToken: 'abcdefghxyz' }))).toBe('share:abcdefgh')
    expect(dialogPrincipal(base({ isControlPanel: false }))).toBe('bearer')
  })
})
