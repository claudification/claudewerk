import { describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { VacuumStepMessage } from '../../../shared/protocol'
import type { UserGrant } from '../../permissions'
import { broadcastVacuumStep, isAdminSocket } from '../broadcast'

interface FakeSocket {
  data: { grants?: UserGrant[]; shareToken?: string }
  sent: string[]
  send(json: string): void
}

function socket(data: FakeSocket['data']): FakeSocket {
  const sent: string[] = []
  return {
    data,
    sent,
    send(json: string) {
      sent.push(json)
    },
  }
}

const ADMIN_GRANT: UserGrant = { scope: '*', roles: ['admin'] }
/** 'admin' is the only Role, so a non-admin user is one holding granular
 *  permissions and no role -- which is exactly what a normal user looks like. */
const VIEWER_GRANT: UserGrant = { scope: '*', permissions: ['chat:read', 'files:read'] }

const STEP: VacuumStepMessage = {
  type: 'vacuum_step',
  runId: 'run1',
  step: 'delete:2026-06',
  status: 'ok',
  detail: 'deleted 565,792 archived rows',
  rowsBefore: 1_256_089,
  rowsAfter: 690_297,
  dbBytesBefore: 10_000,
  dbBytesAfter: 4_000,
  initiator: 'user:jonas',
  dryRun: false,
  ts: 1,
}

function send(sockets: FakeSocket[]): number {
  return broadcastVacuumStep(new Set(sockets as unknown as ServerWebSocket<unknown>[]), STEP)
}

describe('who may see a vacuum step', () => {
  it('sends to a bearer-token connection (no grants = admin-level)', () => {
    const ws = socket({})
    expect(send([ws])).toBe(1)
    expect(JSON.parse(ws.sent[0]).step).toBe('delete:2026-06')
  })

  it('sends to an admin-granted socket', () => {
    expect(send([socket({ grants: [ADMIN_GRANT] })])).toBe(1)
  })

  it('never sends to a share viewer, even one holding admin grants', () => {
    // A share token is a scoped, unauthenticated capability. It must not become
    // a window onto global infrastructure state just because the socket also
    // carries grants -- the two conditions are independent on purpose.
    const shareViewer = socket({ shareToken: 'tok_abc', grants: [ADMIN_GRANT] })
    expect(send([shareViewer])).toBe(0)
    expect(shareViewer.sent).toEqual([])
  })

  it('never sends to a non-admin user', () => {
    const viewer = socket({ grants: [VIEWER_GRANT] })
    expect(send([viewer])).toBe(0)
    expect(viewer.sent).toEqual([])
  })

  it('delivers to exactly the admins in a mixed room', () => {
    const admin = socket({ grants: [ADMIN_GRANT] })
    const viewer = socket({ grants: [VIEWER_GRANT] })
    const guest = socket({ shareToken: 'tok_abc' })
    const bearer = socket({})

    expect(send([admin, viewer, guest, bearer])).toBe(2)
    expect(admin.sent.length).toBe(1)
    expect(bearer.sent.length).toBe(1)
    expect(viewer.sent).toEqual([])
    expect(guest.sent).toEqual([])
  })

  it('keeps broadcasting past a dead socket', () => {
    const dead = {
      data: {},
      sent: [],
      send() {
        throw new Error('socket closed')
      },
    } as FakeSocket
    const alive = socket({})
    expect(send([dead, alive])).toBe(1)
    expect(alive.sent.length).toBe(1)
  })

  it('classifies sockets the same way httpIsAdmin does', () => {
    expect(isAdminSocket({ data: {} } as unknown as ServerWebSocket<unknown>)).toBe(true)
    expect(isAdminSocket({ data: { shareToken: 't' } } as unknown as ServerWebSocket<unknown>)).toBe(false)
    expect(isAdminSocket({ data: { grants: [VIEWER_GRANT] } } as unknown as ServerWebSocket<unknown>)).toBe(false)
    expect(isAdminSocket({ data: { grants: [ADMIN_GRANT] } } as unknown as ServerWebSocket<unknown>)).toBe(true)
  })
})
