import { describe, expect, it } from 'bun:test'
import type { BgTaskInfo, Conversation } from '../../../shared/protocol'
import { reconcileBackgroundTasks } from './background-tasks'

function conv(bgTasks: BgTaskInfo[]): Conversation {
  return { bgTasks } as unknown as Conversation
}

const NOW = 1_000_000

describe('reconcileBackgroundTasks', () => {
  it('adds new host-sourced running tasks from the snapshot', () => {
    const c = conv([])
    const changed = reconcileBackgroundTasks(
      c,
      [
        { id: 'a', kind: 'shell', description: 'echo hi' },
        { id: 'b', kind: 'agent', description: 'map the code' },
      ],
      NOW,
    )
    expect(changed).toBe(true)
    expect(c.bgTasks).toHaveLength(2)
    const a = c.bgTasks.find(t => t.taskId === 'a')!
    expect(a).toMatchObject({ status: 'running', source: 'host', kind: 'shell', command: 'echo hi' })
    const b = c.bgTasks.find(t => t.taskId === 'b')!
    // agent tasks carry no shell command
    expect(b).toMatchObject({ status: 'running', source: 'host', kind: 'agent', command: '' })
  })

  it('completes a host task that dropped out of the snapshot', () => {
    const c = conv([
      { taskId: 'a', command: '', description: 'x', startedAt: NOW, status: 'running', source: 'host', kind: 'shell' },
    ])
    const changed = reconcileBackgroundTasks(c, [], NOW + 5)
    expect(changed).toBe(true)
    expect(c.bgTasks[0]).toMatchObject({ status: 'completed', completedAt: NOW + 5 })
  })

  it('leaves hook-sourced tasks untouched when absent from the snapshot', () => {
    // PTY-style row (source 'hook'); its completion flows via TaskOutput/TaskStop,
    // NOT the host snapshot -- the snapshot must never complete it.
    const c = conv([
      { taskId: 'h', command: 'sleep 9', description: '', startedAt: NOW, status: 'running', source: 'hook' },
    ])
    const changed = reconcileBackgroundTasks(c, [], NOW + 5)
    expect(changed).toBe(false)
    expect(c.bgTasks[0].status).toBe('running')
  })

  it('promotes a matching hook row to host + preserves its richer metadata', () => {
    const c = conv([
      {
        taskId: 'a',
        command: 'bun run build',
        description: 'build the app',
        startedAt: NOW,
        status: 'running',
        source: 'hook',
      },
    ])
    // snapshot description for a shell task is the raw command -- must NOT clobber
    // the nicer hook-provided description/command.
    const changed = reconcileBackgroundTasks(c, [{ id: 'a', kind: 'shell', description: 'bun run build --prod' }], NOW)
    expect(changed).toBe(true)
    expect(c.bgTasks[0]).toMatchObject({
      source: 'host',
      status: 'running',
      command: 'bun run build',
      description: 'build the app',
    })
    expect(c.bgTasks).toHaveLength(1) // upsert, not a duplicate insert
  })

  it('re-running a task that had completed flips it back to running', () => {
    const c = conv([
      {
        taskId: 'a',
        command: '',
        description: 'x',
        startedAt: NOW,
        status: 'completed',
        completedAt: NOW + 1,
        source: 'host',
        kind: 'shell',
      },
    ])
    const changed = reconcileBackgroundTasks(c, [{ id: 'a', kind: 'shell', description: 'x' }], NOW + 9)
    expect(changed).toBe(true)
    expect(c.bgTasks[0]).toMatchObject({ status: 'running', completedAt: undefined })
  })

  it('is idempotent: the same snapshot twice reports no change the second time', () => {
    const c = conv([])
    reconcileBackgroundTasks(c, [{ id: 'a', kind: 'shell', description: 'x' }], NOW)
    const changed = reconcileBackgroundTasks(c, [{ id: 'a', kind: 'shell', description: 'x' }], NOW + 1)
    expect(changed).toBe(false)
  })

  it('skips snapshot items with an empty id', () => {
    const c = conv([])
    const changed = reconcileBackgroundTasks(c, [{ id: '', kind: 'shell', description: 'x' }], NOW)
    expect(changed).toBe(false)
    expect(c.bgTasks).toHaveLength(0)
  })
})
