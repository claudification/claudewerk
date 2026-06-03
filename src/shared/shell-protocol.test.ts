import { describe, expect, test } from 'bun:test'
import type {
  BrokerSentinelMessage,
  ConversationSummary,
  SentinelIdentify,
  SentinelMessage,
  ShellActivity,
  ShellAdded,
  ShellClose,
  ShellData,
  ShellExit,
  ShellInput,
  ShellOpen,
  ShellRemoved,
  ShellReplay,
  ShellResize,
  ShellRoster,
  ShellRosterEntry,
  ShellSubscribe,
  ShellUnsubscribe,
  TranscriptEntry,
  TranscriptShellEntry,
} from './protocol'

// Phase 1 contract guard for the host-shell wire protocol (plan-host-shell.md).
// Pure type definitions have no runtime behavior to exercise, so these tests
// pin the SHAPE: discriminator literals, required fields, and union membership.
// They fail loudly if a later phase renames/removes a field downstream code
// depends on. The `satisfies` annotations are the real assertion (compile-time);
// the `expect`s keep the test runner honest at runtime.

const SHELL_ID = 'sh_abc123'
const PROJECT_URI = 'claude://sentinel-1/Users/jonas/projects/demo'

describe('host-shell roster plane', () => {
  test('ShellRosterEntry carries the full floating-shell fact', () => {
    const entry: ShellRosterEntry = {
      shellId: SHELL_ID,
      projectUri: PROJECT_URI,
      sentinelId: 'sentinel-1',
      path: '/Users/jonas/projects/demo',
      title: 'demo',
      status: 'live',
      createdBy: 'jonas',
      createdAt: 1_700_000_000_000,
    }
    expect(entry.status).toBe('live')
    // status is a closed union -- 'exited' is the only other member.
    const exited: ShellRosterEntry['status'] = 'exited'
    expect(exited).toBe('exited')
  })

  test('roster broadcast messages have the right discriminators', () => {
    const roster = { type: 'shell_roster', shells: [] } satisfies ShellRoster
    const added = {
      type: 'shell_added',
      shell: {
        shellId: SHELL_ID,
        projectUri: PROJECT_URI,
        sentinelId: 'sentinel-1',
        path: '/Users/jonas/projects/demo',
        title: 'demo',
        status: 'live',
        createdBy: 'jonas',
        createdAt: 1,
      },
    } satisfies ShellAdded
    const removed = { type: 'shell_removed', shellId: SHELL_ID, code: 0 } satisfies ShellRemoved
    const activity = { type: 'shell_activity', shellId: SHELL_ID, ts: 42 } satisfies ShellActivity

    expect(roster.type).toBe('shell_roster')
    expect(added.type).toBe('shell_added')
    expect(removed.type).toBe('shell_removed')
    expect(activity.type).toBe('shell_activity')
    // code is optional on shell_removed (absent on sentinel-disconnect cleanup).
    const removedNoCode: ShellRemoved = { type: 'shell_removed', shellId: SHELL_ID }
    expect(removedNoCode.code).toBeUndefined()
  })
})

describe('host-shell data plane', () => {
  test('subscribe / unsubscribe / bytes carry shellId', () => {
    const sub = { type: 'shell_subscribe', shellId: SHELL_ID, cols: 80, rows: 24 } satisfies ShellSubscribe
    const unsub = { type: 'shell_unsubscribe', shellId: SHELL_ID } satisfies ShellUnsubscribe
    const data = { type: 'shell_data', shellId: SHELL_ID, data: 'hi' } satisfies ShellData
    const input = { type: 'shell_input', shellId: SHELL_ID, data: 'ls\n' } satisfies ShellInput
    const resize = { type: 'shell_resize', shellId: SHELL_ID, cols: 120, rows: 40 } satisfies ShellResize
    const replay = { type: 'shell_replay', shellId: SHELL_ID, data: 'scrollback', done: true } satisfies ShellReplay

    expect([sub.type, unsub.type, data.type, input.type, resize.type, replay.type]).toEqual([
      'shell_subscribe',
      'shell_unsubscribe',
      'shell_data',
      'shell_input',
      'shell_resize',
      'shell_replay',
    ])
    expect(replay.done).toBe(true)
  })
})

describe('host-shell control plane', () => {
  test('open carries the addressing + optional grouping fields', () => {
    const open = {
      type: 'shell_open',
      projectUri: PROJECT_URI,
      shellId: SHELL_ID,
      cols: 80,
      rows: 24,
      title: 'demo',
      conversationId: 'conv_xyz',
    } satisfies ShellOpen
    // title + conversationId are optional (UI-grouping only).
    const openMinimal: ShellOpen = {
      type: 'shell_open',
      projectUri: PROJECT_URI,
      shellId: SHELL_ID,
      cols: 80,
      rows: 24,
    }
    expect(open.conversationId).toBe('conv_xyz')
    expect(openMinimal.title).toBeUndefined()
  })

  test('close + exit discriminators', () => {
    const close = { type: 'shell_close', shellId: SHELL_ID } satisfies ShellClose
    const exit = { type: 'shell_exit', shellId: SHELL_ID, code: 137 } satisfies ShellExit
    expect(close.type).toBe('shell_close')
    expect(exit.code).toBe(137)
  })
})

describe('host-shell union membership', () => {
  test('sentinel -> broker shell messages belong to SentinelMessage', () => {
    const exit: SentinelMessage = { type: 'shell_exit', shellId: SHELL_ID, code: 0 }
    const activity: SentinelMessage = { type: 'shell_activity', shellId: SHELL_ID, ts: 1 }
    const data: SentinelMessage = { type: 'shell_data', shellId: SHELL_ID, data: 'x' }
    const replay: SentinelMessage = { type: 'shell_replay', shellId: SHELL_ID, data: 'x', done: false }
    expect([exit.type, activity.type, data.type, replay.type]).toContain('shell_exit')
  })

  test('broker -> sentinel shell messages belong to BrokerSentinelMessage', () => {
    const open: BrokerSentinelMessage = {
      type: 'shell_open',
      projectUri: PROJECT_URI,
      shellId: SHELL_ID,
      cols: 80,
      rows: 24,
    }
    const close: BrokerSentinelMessage = { type: 'shell_close', shellId: SHELL_ID }
    const input: BrokerSentinelMessage = { type: 'shell_input', shellId: SHELL_ID, data: 'x' }
    const resize: BrokerSentinelMessage = { type: 'shell_resize', shellId: SHELL_ID, cols: 1, rows: 1 }
    expect([open.type, close.type, input.type, resize.type]).toContain('shell_open')
  })
})

describe('host-shell transcript entry', () => {
  test('open + exit events are assignable to TranscriptEntry', () => {
    const open: TranscriptShellEntry = {
      type: 'shell',
      shellId: SHELL_ID,
      event: 'open',
      projectUri: PROJECT_URI,
      path: '/Users/jonas/projects/demo',
      title: 'demo',
      createdBy: 'jonas',
    }
    const exit: TranscriptShellEntry = {
      type: 'shell',
      shellId: SHELL_ID,
      event: 'exit',
      code: 0,
    }
    const asEntryOpen: TranscriptEntry = open
    const asEntryExit: TranscriptEntry = exit
    expect(asEntryOpen.type).toBe('shell')
    expect(asEntryExit.type).toBe('shell')
    expect(open.event).toBe('open')
    expect(exit.event).toBe('exit')
  })
})

describe('sentinel shell feature advertisement', () => {
  test('SentinelIdentify carries optional features.shell', () => {
    const withShell: SentinelIdentify = { type: 'sentinel_identify', features: { shell: true } }
    const withoutFeatures: SentinelIdentify = { type: 'sentinel_identify' }
    expect(withShell.features?.shell).toBe(true)
    expect(withoutFeatures.features).toBeUndefined()
  })

  test('ConversationSummary exposes derived shellCapable', () => {
    const shellCapable: ConversationSummary['shellCapable'] = true
    expect(shellCapable).toBe(true)
    // optional -- absent means default (not shell-capable / unknown).
    const absent: ConversationSummary['shellCapable'] = undefined
    expect(absent).toBeUndefined()
  })
})
