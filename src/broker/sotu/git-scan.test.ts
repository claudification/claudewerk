import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitFabric, GitFabricRequest } from '../../shared/protocol'
import { clearDeskEventHandlers, emitDeskEvent } from '../desk/event-registry'
import type { GitFabricTransport } from './git-fabric-gather'
import { requestSotuScan, startSotuGitScan, stopSotuGitScan } from './git-scan'
import { initSotuStore, projectSlug } from './index'
import { readQueue } from './queue'
import { readState } from './state'

const PROJECT = '/Users/jonas/projects/remote-claude'
let dir: string

const fabric: GitFabric = {
  branches: [
    {
      branch: 'main',
      aheadOrigin: 0,
      behindOrigin: 0,
      aheadLocal: 0,
      behindLocal: 0,
      integration: 'integrated',
      alerts: [],
    },
  ],
  scannedAt: 0,
}

function fakeTransport(onSend?: () => void): GitFabricTransport {
  const pending = new Map<string, (result: unknown) => void>()
  const sentinel = {
    send(data: string) {
      onSend?.()
      const req = JSON.parse(data) as GitFabricRequest
      pending.get(req.requestId)?.({
        type: 'git_fabric_result',
        requestId: req.requestId,
        projectUri: req.projectUri,
        success: true,
        fabric,
      })
    },
  }
  return {
    getSentinelByAlias: () => sentinel,
    getSentinel: () => sentinel,
    addFileListener: (id, cb) => pending.set(id, cb),
    removeFileListener: id => pending.delete(id),
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sotu-gitscan-'))
  initSotuStore(dir)
})
afterEach(() => {
  stopSotuGitScan()
  clearDeskEventHandlers()
  rmSync(dir, { recursive: true, force: true })
})

test('a lifecycle event triggers a debounced scan -> git_scan contribution', async () => {
  const broadcasts: Record<string, unknown>[] = []
  startSotuGitScan({
    transport: fakeTransport(),
    broadcast: m => broadcasts.push(m),
    quietSettleMs: 5,
    minIntervalMs: 5,
  })
  emitDeskEvent({ kind: 'lifecycle', conversationId: 'c1', project: PROJECT, ts: 1, transition: 'created' })
  await Bun.sleep(40)
  const q = readQueue(projectSlug(PROJECT))
  expect(q).toHaveLength(1)
  expect(q[0]).toMatchObject({ kind: 'git_scan' })
  // git_scan weighs 1 (the derived/baseline floor).
  expect(readState(projectSlug(PROJECT)).pendingContribs).toBe(1)
  expect(broadcasts).toHaveLength(1)
  expect(broadcasts[0]).toMatchObject({ type: 'sotu_contribution', project: PROJECT })
})

test('a burst of events coalesces into a single scan', async () => {
  let sends = 0
  startSotuGitScan({
    transport: fakeTransport(() => {
      sends++
    }),
    broadcast: () => {},
    quietSettleMs: 15,
    minIntervalMs: 15,
  })
  for (let i = 0; i < 5; i++) {
    emitDeskEvent({ kind: 'lifecycle', conversationId: `c${i}`, project: PROJECT, ts: i, transition: 'created' })
  }
  await Bun.sleep(50)
  expect(sends).toBe(1)
  expect(readQueue(projectSlug(PROJECT))).toHaveLength(1)
})

test('non-lifecycle and project-less events never scan', async () => {
  let sends = 0
  startSotuGitScan({
    transport: fakeTransport(() => {
      sends++
    }),
    broadcast: () => {},
    quietSettleMs: 5,
    minIntervalMs: 5,
  })
  emitDeskEvent({ kind: 'turn_complete', conversationId: 'c1', project: PROJECT, ts: 1 })
  emitDeskEvent({ kind: 'lifecycle', conversationId: 'c2', project: null, ts: 2, transition: 'created' })
  await Bun.sleep(30)
  expect(sends).toBe(0)
  expect(readQueue(projectSlug(PROJECT))).toHaveLength(0)
})

test('stopSotuGitScan unsubscribes -- no further scans', async () => {
  let sends = 0
  startSotuGitScan({
    transport: fakeTransport(() => {
      sends++
    }),
    broadcast: () => {},
    quietSettleMs: 5,
    minIntervalMs: 5,
  })
  stopSotuGitScan()
  emitDeskEvent({ kind: 'lifecycle', conversationId: 'c1', project: PROJECT, ts: 1, transition: 'created' })
  await Bun.sleep(20)
  expect(sends).toBe(0)
})

test('scan-on-read: requestSotuScan schedules a floored scan', async () => {
  let sends = 0
  startSotuGitScan({
    transport: fakeTransport(() => {
      sends++
    }),
    broadcast: () => {},
    quietSettleMs: 5,
    minIntervalMs: 5,
  })
  requestSotuScan(PROJECT)
  requestSotuScan(PROJECT) // coalesces with the pending one
  await Bun.sleep(40)
  expect(sends).toBe(1)
  expect(readQueue(projectSlug(PROJECT))).toHaveLength(1)
})

test('periodic: re-arms while the project has recent LLM activity', async () => {
  let sends = 0
  startSotuGitScan({
    transport: fakeTransport(() => {
      sends++
    }),
    broadcast: () => {},
    hasRecentActivity: () => true,
    quietSettleMs: 5,
    minIntervalMs: 5,
    periodicMs: 15,
  })
  requestSotuScan(PROJECT)
  await Bun.sleep(80)
  // Initial scan + at least one periodic rescan fired without further events.
  expect(sends).toBeGreaterThanOrEqual(2)
})

test('periodic: deep sleep when the project has no recent LLM activity', async () => {
  let sends = 0
  startSotuGitScan({
    transport: fakeTransport(() => {
      sends++
    }),
    broadcast: () => {},
    hasRecentActivity: () => false,
    quietSettleMs: 5,
    minIntervalMs: 5,
    periodicMs: 10,
  })
  requestSotuScan(PROJECT)
  await Bun.sleep(60)
  expect(sends).toBe(1) // the read scan ran; no periodic follow-up armed
})
