/**
 * Broker host-shell HANDLER tests (phase 5).
 *
 * `shell-registry.test.ts` pins the pure roster/min-size/pairing data structure.
 * This file pins the wiring in `handlers/shell.ts` -- the parts a registry unit
 * test can't reach: the permission GATES, the share-guest role exclusion, the
 * control->sentinel routing, the data fan-out to SUBSCRIBED viewers only, the
 * lifecycle (open/exit/close + sentinel-disconnect roster cleanup), and the
 * reconnect-replay / lazy-attach trigger.
 *
 * Tests drive the REAL router (`registerShellHandlers` + `routeMessage`) so the
 * role allowlist (WEB_ONLY=['control-panel'], SENTINEL_ONLY) and the
 * GuardError -> `*_result ok:false` deny path are exercised exactly as shipped.
 * A denied call must produce a deny reply AND no side effect -- both are asserted.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { Conversation } from '../../shared/protocol'
import type { SentinelConnection } from '../conversation-store/sentinel'
import { GuardError, type HandlerContext } from '../handler-context'
import { routeMessage } from '../message-router'
import type { Permission } from '../permissions'
import { shellRegistry } from '../shell-registry'
import { dropShellViewerSocket, onSentinelDisconnect, registerShellHandlers } from './shell'

registerShellHandlers()

const URI = 'claude://default/Users/jonas/projects/x'
const URI_Y = 'claude://default/Users/jonas/projects/y'

/** A fake socket that records every frame written to it (parsed back to JSON). */
function recSocket(): { ws: ServerWebSocket<unknown>; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const ws = { send: (s: string) => sent.push(JSON.parse(s)) } as unknown as ServerWebSocket<unknown>
  return { ws, sent }
}

interface World {
  sentinel: ReturnType<typeof recSocket> // control WS
  data: ReturnType<typeof recSocket> // dedicated shell-data WS
  conn: SentinelConnection
  broadcasts: { msg: Record<string, unknown>; uri: string }[]
  transcripts: { id: string; entries: unknown[] }[]
  channels: { id: string; msg: unknown }[]
  convs: Map<string, Conversation>
  store: Record<string, unknown>
}

/** Build a fake conversation store + a single online `default` sentinel. */
function makeWorld(opts: { sentinelOnline?: boolean; machineId?: string } = {}): World {
  const online = opts.sentinelOnline !== false
  const machineId = opts.machineId ?? 'm1'
  const sentinel = recSocket()
  const data = recSocket()
  const conn: SentinelConnection = {
    ws: sentinel.ws,
    sentinelId: 'snt_a',
    alias: 'default',
    machineId,
    connectedAt: 0,
    lastHeartbeat: 0,
  }
  const broadcasts: World['broadcasts'] = []
  const transcripts: World['transcripts'] = []
  const channels: World['channels'] = []
  const convs = new Map<string, Conversation>()
  const store = {
    getSentinelConnectionByAlias: (a: string) => (online && a === 'default' ? conn : undefined),
    getDefaultSentinelConnection: () => (online ? conn : undefined),
    getSentinelIdBySocket: () => 'snt_a',
    broadcastShellScoped: (msg: Record<string, unknown>, uri: string) => broadcasts.push({ msg, uri }),
    getConversation: (id: string) => convs.get(id),
    findConversationByConversationId: () => undefined,
    addTranscriptEntries: (id: string, entries: unknown[]) => transcripts.push({ id, entries }),
    broadcastToChannel: (_ch: string, id: string, msg: unknown) => channels.push({ id, msg }),
  }
  if (online) shellRegistry.setDataSocket(machineId, data.ws)
  return { sentinel, data, conn, broadcasts, transcripts, channels, convs, store }
}

type Role = 'web' | 'share' | 'sentinel-control' | 'sentinel-data'

/** WsData marker fields per role -- detectRole keys off exactly these. */
function wsDataFor(role: Role, opts: { userName?: string; machineId?: string }): Record<string, unknown> {
  const byRole: Record<Role, Record<string, unknown>> = {
    web: { isControlPanel: true, userName: opts.userName ?? 'jonas' },
    share: { isShare: true },
    'sentinel-control': { isSentinel: true, sentinelId: 'snt_a' },
    'sentinel-data': { isShellData: true, shellDataMachineId: opts.machineId ?? 'm1' },
  }
  return byRole[role]
}

/** A caller ctx for `routeMessage`. `grants` lists the permissions
 *  `requirePermission` ALLOWS; any other permission throws GuardError (deny). */
function ctxFor(
  world: World,
  opts: { role?: Role; grants?: Permission[]; userName?: string; machineId?: string } = {},
): { ctx: HandlerContext; replies: Record<string, unknown>[] } {
  const replies: Record<string, unknown>[] = []
  const data = wsDataFor(opts.role ?? 'web', opts)
  const grants = opts.grants
  const ctx = {
    ws: { data },
    conversations: world.store,
    requirePermission: (perm: Permission) => {
      if (grants && !grants.includes(perm)) throw new GuardError(`Permission denied: ${perm}`)
    },
    reply: (m: Record<string, unknown>) => replies.push(m),
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  return { ctx, replies }
}

/** Seed an optimistic roster entry directly (bypassing the open handler). */
function seedShell(shellId: string, over: { uri?: string; machineId?: string; conversationId?: string } = {}): void {
  shellRegistry.add(
    {
      shellId,
      projectUri: over.uri ?? URI,
      sentinelId: 'snt_a',
      path: '/Users/jonas/projects/x',
      title: 'x',
      status: 'live',
      createdBy: 'jonas',
      createdAt: 1_700_000_000_000,
    },
    { machineId: over.machineId ?? 'm1', conversationId: over.conversationId },
  )
}

function denied(replies: Record<string, unknown>[], type: string): boolean {
  return replies.some(r => r.type === `${type}_result` && r.ok === false)
}

/** A `shell_resync.shells[]` entry (sentinel's live-roster wire shape). */
function resyncEntry(shellId: string, uri = URI) {
  return {
    shellId,
    projectUri: uri,
    path: '/Users/jonas/projects/x',
    title: shellId,
    createdBy: 'jonas',
    createdAt: 1_700_000_000_000,
  }
}

const FULL: Permission[] = ['terminal', 'terminal:read']
const READ_ONLY: Permission[] = ['terminal:read']

beforeEach(() => {
  for (const e of shellRegistry.list()) shellRegistry.remove(e.shellId)
})
afterEach(() => {
  for (const e of shellRegistry.list()) shellRegistry.remove(e.shellId)
})

// ── PERM-GATE ────────────────────────────────────────────────────────

describe('shell perm-gate', () => {
  it('opens a shell with terminal (write) and routes it to the sentinel', () => {
    const w = makeWorld()
    const { ctx } = ctxFor(w, { grants: FULL })
    routeMessage(ctx, 'shell_open', { type: 'shell_open', projectUri: URI, shellId: 'sh1', cols: 100, rows: 40 })
    expect(shellRegistry.has('sh1')).toBe(true)
    expect(w.sentinel.sent).toHaveLength(1)
    expect(w.sentinel.sent[0]).toMatchObject({ type: 'shell_open', shellId: 'sh1', cols: 100, rows: 40 })
  })

  it('DENIES open without terminal (write) -- deny reply + zero side effect', () => {
    const w = makeWorld()
    const { ctx, replies } = ctxFor(w, { grants: READ_ONLY })
    routeMessage(ctx, 'shell_open', { type: 'shell_open', projectUri: URI, shellId: 'sh1', cols: 80, rows: 24 })
    expect(denied(replies, 'shell_open')).toBe(true)
    expect(shellRegistry.has('sh1')).toBe(false) // no optimistic roster add
    expect(w.sentinel.sent).toHaveLength(0) // never reached the sentinel
    expect(w.broadcasts).toHaveLength(0) // no shell_added leaked
  })

  it('EXCLUDES share guests from the shell control plane (role gate)', () => {
    const w = makeWorld()
    // grants would pass requirePermission -- but the ROLE gate must reject first.
    const { ctx, replies } = ctxFor(w, { role: 'share', grants: FULL })
    routeMessage(ctx, 'shell_open', { type: 'shell_open', projectUri: URI, shellId: 'sh1', cols: 80, rows: 24 })
    expect(denied(replies, 'shell_open')).toBe(true)
    expect(replies[0]?.error).toMatch(/Forbidden/)
    expect(shellRegistry.has('sh1')).toBe(false)
    expect(w.sentinel.sent).toHaveLength(0)
  })

  it('excludes share guests from subscribing (cannot even watch)', () => {
    const w = makeWorld()
    seedShell('sh1')
    const { ctx, replies } = ctxFor(w, { role: 'share', grants: FULL })
    routeMessage(ctx, 'shell_subscribe', { type: 'shell_subscribe', shellId: 'sh1', cols: 80, rows: 24 })
    expect(denied(replies, 'shell_subscribe')).toBe(true)
    expect(w.data.sent).toHaveLength(0) // no attach -> no byte stream
  })

  it('subscribes (watch) with terminal:read only', () => {
    const w = makeWorld()
    seedShell('sh1')
    const { ctx } = ctxFor(w, { grants: READ_ONLY })
    routeMessage(ctx, 'shell_subscribe', { type: 'shell_subscribe', shellId: 'sh1', cols: 90, rows: 30 })
    expect(w.data.sent[0]).toMatchObject({ type: 'shell_attach', shellId: 'sh1', cols: 90, rows: 30, replay: true })
  })

  it('DENIES subscribe without terminal:read', () => {
    const w = makeWorld()
    seedShell('sh1')
    const { ctx, replies } = ctxFor(w, { grants: [] })
    routeMessage(ctx, 'shell_subscribe', { type: 'shell_subscribe', shellId: 'sh1', cols: 80, rows: 24 })
    expect(denied(replies, 'shell_subscribe')).toBe(true)
    expect(w.data.sent).toHaveLength(0)
  })

  it('read/write split: a read-only viewer can watch but NOT type or kill', () => {
    const w = makeWorld()
    seedShell('sh1')
    // subscribe (read) succeeds
    routeMessage(ctxFor(w, { grants: READ_ONLY }).ctx, 'shell_subscribe', {
      type: 'shell_subscribe',
      shellId: 'sh1',
      cols: 80,
      rows: 24,
    })
    expect(w.data.sent.some(f => f.type === 'shell_attach')).toBe(true)

    // input (write) denied
    const input = ctxFor(w, { grants: READ_ONLY })
    routeMessage(input.ctx, 'shell_input', { type: 'shell_input', shellId: 'sh1', data: 'rm -rf\n' })
    expect(denied(input.replies, 'shell_input')).toBe(true)
    expect(w.data.sent.some(f => f.type === 'shell_input')).toBe(false)

    // close (write) denied
    const close = ctxFor(w, { grants: READ_ONLY })
    routeMessage(close.ctx, 'shell_close', { type: 'shell_close', shellId: 'sh1' })
    expect(denied(close.replies, 'shell_close')).toBe(true)
    expect(w.sentinel.sent.some(f => f.type === 'shell_close')).toBe(false)
  })

  it('rejects open for an unknown projectUri (offline sentinel)', () => {
    const w = makeWorld({ sentinelOnline: false })
    const { ctx, replies } = ctxFor(w, { grants: FULL })
    routeMessage(ctx, 'shell_open', { type: 'shell_open', projectUri: URI, shellId: 'sh1', cols: 80, rows: 24 })
    expect(denied(replies, 'shell_open')).toBe(true)
    expect(shellRegistry.has('sh1')).toBe(false)
  })

  it('rejects a duplicate shellId open', () => {
    const w = makeWorld()
    seedShell('sh1')
    const { ctx, replies } = ctxFor(w, { grants: FULL })
    routeMessage(ctx, 'shell_open', { type: 'shell_open', projectUri: URI, shellId: 'sh1', cols: 80, rows: 24 })
    expect(denied(replies, 'shell_open')).toBe(true)
    expect(w.sentinel.sent).toHaveLength(0)
  })
})

// ── ROUTING ──────────────────────────────────────────────────────────

describe('shell routing', () => {
  it('emits shell_added + a TranscriptShellEntry open receipt when a conversation is attached', () => {
    const w = makeWorld()
    w.convs.set('conv_x', { id: 'conv_x' } as Conversation)
    const { ctx } = ctxFor(w, { grants: FULL })
    routeMessage(ctx, 'shell_open', {
      type: 'shell_open',
      projectUri: URI,
      shellId: 'sh1',
      cols: 80,
      rows: 24,
      conversationId: 'conv_x',
    })
    expect(w.broadcasts.some(b => b.msg.type === 'shell_added' && b.uri === URI)).toBe(true)
    expect(w.transcripts).toHaveLength(1)
    const entry = (w.transcripts[0]?.entries as Record<string, unknown>[])[0]
    expect(entry).toMatchObject({ type: 'shell', event: 'open', shellId: 'sh1' })
    expect(w.channels.some(c => c.id === 'conv_x')).toBe(true)
  })

  it('fans shell_data to SUBSCRIBED viewers only', () => {
    const w = makeWorld()
    seedShell('sh1')
    const subA = recSocket()
    const subB = recSocket()
    const nonSub = recSocket()
    shellRegistry.subscribe('sh1', subA.ws, 80, 24)
    shellRegistry.subscribe('sh1', subB.ws, 80, 24)
    const { ctx } = ctxFor(w, { role: 'sentinel-data' })
    routeMessage(ctx, 'shell_data', { type: 'shell_data', shellId: 'sh1', data: 'hello' })
    expect(subA.sent.some(f => f.type === 'shell_data' && f.data === 'hello')).toBe(true)
    expect(subB.sent.some(f => f.type === 'shell_data' && f.data === 'hello')).toBe(true)
    expect(nonSub.sent).toHaveLength(0)
  })

  it('drops shell_data from a data socket that does not own the shell (machineId mismatch)', () => {
    const w = makeWorld()
    seedShell('sh1', { machineId: 'm1' })
    const sub = recSocket()
    shellRegistry.subscribe('sh1', sub.ws, 80, 24)
    const { ctx } = ctxFor(w, { role: 'sentinel-data', machineId: 'imposter' })
    routeMessage(ctx, 'shell_data', { type: 'shell_data', shellId: 'sh1', data: 'evil' })
    expect(sub.sent).toHaveLength(0)
  })

  it('routes shell_input over the owning sentinel data socket', () => {
    const w = makeWorld()
    seedShell('sh1')
    const { ctx } = ctxFor(w, { grants: FULL })
    routeMessage(ctx, 'shell_input', { type: 'shell_input', shellId: 'sh1', data: 'ls\n' })
    expect(w.data.sent.some(f => f.type === 'shell_input' && f.data === 'ls\n')).toBe(true)
  })

  it('routes shell_close to the sentinel control socket but keeps the roster until exit', () => {
    const w = makeWorld()
    seedShell('sh1')
    const { ctx } = ctxFor(w, { grants: FULL })
    routeMessage(ctx, 'shell_close', { type: 'shell_close', shellId: 'sh1' })
    expect(w.sentinel.sent.some(f => f.type === 'shell_close' && f.shellId === 'sh1')).toBe(true)
    expect(shellRegistry.has('sh1')).toBe(true) // authoritative removal waits for shell_exit
  })
})

// ── RECONNECT REPLAY + MIN-SIZE handler glue ─────────────────────────

describe('shell subscribe -> attach/replay + min-size', () => {
  it('first subscriber triggers exactly one shell_attach{replay:true}', () => {
    const w = makeWorld()
    seedShell('sh1')
    routeMessage(ctxFor(w, { grants: READ_ONLY }).ctx, 'shell_subscribe', {
      type: 'shell_subscribe',
      shellId: 'sh1',
      cols: 120,
      rows: 40,
    })
    const attaches = w.data.sent.filter(f => f.type === 'shell_attach')
    expect(attaches).toHaveLength(1)
    expect(attaches[0]).toMatchObject({ replay: true, cols: 120, rows: 40 })
  })

  it('a second smaller viewer shrinks the PTY via shell_resize (tmux min across viewers)', () => {
    const w = makeWorld()
    seedShell('sh1')
    routeMessage(ctxFor(w, { grants: READ_ONLY }).ctx, 'shell_subscribe', {
      type: 'shell_subscribe',
      shellId: 'sh1',
      cols: 120,
      rows: 40,
    })
    routeMessage(ctxFor(w, { grants: READ_ONLY }).ctx, 'shell_subscribe', {
      type: 'shell_subscribe',
      shellId: 'sh1',
      cols: 80,
      rows: 24,
    })
    expect(w.data.sent.some(f => f.type === 'shell_resize' && f.cols === 80 && f.rows === 24)).toBe(true)
  })
})

// ── LIFECYCLE ────────────────────────────────────────────────────────

describe('shell lifecycle', () => {
  it('shell_exit removes the roster entry, broadcasts shell_removed, emits an exit receipt', () => {
    const w = makeWorld()
    w.convs.set('conv_x', { id: 'conv_x' } as Conversation)
    seedShell('sh1', { conversationId: 'conv_x' })
    const { ctx } = ctxFor(w, { role: 'sentinel-control' })
    routeMessage(ctx, 'shell_exit', { type: 'shell_exit', shellId: 'sh1', code: 0 })
    expect(shellRegistry.has('sh1')).toBe(false)
    expect(w.broadcasts.some(b => b.msg.type === 'shell_removed' && b.msg.code === 0)).toBe(true)
    const entry = (w.transcripts[0]?.entries as Record<string, unknown>[])[0]
    expect(entry).toMatchObject({ type: 'shell', event: 'exit', shellId: 'sh1' })
  })

  it('shell_activity broadcasts a blink scoped to the shell URI without removing it', () => {
    const w = makeWorld()
    seedShell('sh1')
    const { ctx } = ctxFor(w, { role: 'sentinel-control' })
    routeMessage(ctx, 'shell_activity', { type: 'shell_activity', shellId: 'sh1', ts: 123 })
    expect(w.broadcasts.some(b => b.msg.type === 'shell_activity' && b.msg.ts === 123 && b.uri === URI)).toBe(true)
    expect(shellRegistry.has('sh1')).toBe(true)
  })

  it('onSentinelDisconnect DEFERS removal during the grace window (floating shells survive a blip)', () => {
    const w = makeWorld()
    seedShell('a')
    seedShell('b')
    onSentinelDisconnect('snt_a', w.store as never)
    // PTYs keep running sentinel-side -> the broker holds the roster, no removal yet.
    expect(shellRegistry.has('a')).toBe(true)
    expect(shellRegistry.has('b')).toBe(true)
    expect(w.broadcasts.filter(x => x.msg.type === 'shell_removed')).toHaveLength(0)
    // A resync within the window cancels the grace timer (see next tests). Flush
    // it here so no real timer dangles past the test.
    const { ctx } = ctxFor(w, { role: 'sentinel-control' })
    routeMessage(ctx, 'shell_resync', {
      type: 'shell_resync',
      machineId: 'm1',
      shells: [resyncEntry('a'), resyncEntry('b')],
    })
  })

  it('grace expiry removes the machine’s shells + broadcasts shell_removed (sentinel never returned)', () => {
    jest.useFakeTimers()
    try {
      const w = makeWorld()
      seedShell('a')
      seedShell('b')
      // a third shell on a DIFFERENT machine must survive (grace is machine-scoped)
      shellRegistry.add(
        {
          shellId: 'c',
          projectUri: URI_Y,
          sentinelId: 'snt_b',
          path: '/Users/jonas/projects/y',
          title: 'y',
          status: 'live',
          createdBy: 'jonas',
          createdAt: 1,
        },
        { machineId: 'm2' },
      )
      onSentinelDisconnect('snt_a', w.store as never)
      expect(shellRegistry.has('a')).toBe(true) // still present during grace
      jest.advanceTimersByTime(45_000)
      expect(shellRegistry.has('a')).toBe(false)
      expect(shellRegistry.has('b')).toBe(false)
      expect(shellRegistry.has('c')).toBe(true)
      const removed = w.broadcasts.filter(x => x.msg.type === 'shell_removed').map(x => x.msg.shellId)
      expect(removed.sort()).toEqual(['a', 'b'])
    } finally {
      jest.useRealTimers()
    }
  })

  it('a resync within the grace window cancels removal -- kept, no flap', () => {
    jest.useFakeTimers()
    try {
      const w = makeWorld()
      seedShell('a')
      seedShell('b')
      onSentinelDisconnect('snt_a', w.store as never)
      const { ctx } = ctxFor(w, { role: 'sentinel-control' })
      routeMessage(ctx, 'shell_resync', {
        type: 'shell_resync',
        machineId: 'm1',
        shells: [resyncEntry('a'), resyncEntry('b')],
      })
      // Advance well past the grace window -- the canceled timer must NOT fire.
      jest.advanceTimersByTime(60_000)
      expect(shellRegistry.has('a')).toBe(true)
      expect(shellRegistry.has('b')).toBe(true)
      // Already-present shells -> kept, so no shell_added flap + no removal.
      expect(w.broadcasts.filter(x => x.msg.type === 'shell_added')).toHaveLength(0)
      expect(w.broadcasts.filter(x => x.msg.type === 'shell_removed')).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('dropShellViewerSocket detaches the sentinel when a watcher disconnects (last viewer)', () => {
    const w = makeWorld()
    seedShell('sh1')
    const viewer = recSocket()
    shellRegistry.subscribe('sh1', viewer.ws, 80, 24)
    dropShellViewerSocket(viewer.ws)
    expect(w.data.sent.some(f => f.type === 'shell_detach' && f.shellId === 'sh1')).toBe(true)
  })
})

// ── RESYNC RECONCILE (broker-restart recovery) ───────────────────────

describe('shell_resync reconcile', () => {
  it('re-adds reported shells on an EMPTY roster + broadcasts shell_added (broker restart)', () => {
    const w = makeWorld()
    const { ctx } = ctxFor(w, { role: 'sentinel-control' })
    routeMessage(ctx, 'shell_resync', {
      type: 'shell_resync',
      machineId: 'm1',
      shells: [resyncEntry('a'), resyncEntry('b')],
    })
    expect(shellRegistry.has('a')).toBe(true)
    expect(shellRegistry.has('b')).toBe(true)
    // The resyncing connection's sentinelId is stamped on the revived entries.
    expect(shellRegistry.get('a')?.entry.sentinelId).toBe('snt_a')
    const added = w.broadcasts
      .filter(x => x.msg.type === 'shell_added')
      .map(x => (x.msg.shell as { shellId: string }).shellId)
    expect(added.sort()).toEqual(['a', 'b'])
  })

  it('prunes shells the sentinel no longer reports + broadcasts shell_removed', () => {
    const w = makeWorld()
    seedShell('a')
    seedShell('b')
    const { ctx } = ctxFor(w, { role: 'sentinel-control' })
    routeMessage(ctx, 'shell_resync', { type: 'shell_resync', machineId: 'm1', shells: [resyncEntry('a')] })
    expect(shellRegistry.has('a')).toBe(true)
    expect(shellRegistry.has('b')).toBe(false)
    expect(w.broadcasts.some(x => x.msg.type === 'shell_removed' && x.msg.shellId === 'b')).toBe(true)
    // 'a' was already present -> kept, not re-added (no flap).
    expect(w.broadcasts.some(x => x.msg.type === 'shell_added')).toBe(false)
  })

  it('is REJECTED from a web (control-panel) role -- sentinel-only inbound', () => {
    const w = makeWorld()
    const { ctx } = ctxFor(w, { role: 'web', grants: FULL })
    const handled = routeMessage(ctx, 'shell_resync', {
      type: 'shell_resync',
      machineId: 'm1',
      shells: [resyncEntry('a')],
    })
    // A web client must not be able to forge a roster. Either the router refuses
    // to dispatch it (role gate) or it produces no roster mutation.
    expect(shellRegistry.has('a')).toBe(false)
    expect(handled === false || w.broadcasts.length === 0).toBe(true)
  })
})
