import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Conversation } from '../../shared/protocol'
import { closeProjectStore, getOrCreateProject, initProjectStore } from '../project-store'
import { buildDispatchToolset } from './dispatch-tools'
import { closeProjectMemory, ensureBriefRow, initProjectMemory, writeBrief } from './project-memory'
import { projectKeyOf } from './projects'
import type { DispatchRuntime } from './runtime'
import type { ToolContext } from './tool-def'

const ARR = 'claude://default/Users/jonas/projects/arr'
const ARR_KEY = projectKeyOf(ARR) as string

let dir: string
function fakeRt(convs: Partial<Conversation>[]): DispatchRuntime {
  return { store: { getAllConversations: () => convs as Conversation[] } } as unknown as DispatchRuntime
}
/** Seed a condensed brief the way the service does (ensure row, then write). */
function seedBrief(text: string): void {
  ensureBriefRow(ARR_KEY, ARR, 'arr', 1)
  writeBrief({ projectKey: ARR_KEY, brief: text, now: 1 })
}
const ctx: ToolContext = {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dt-'))
  initProjectStore(dir)
  initProjectMemory(dir)
  getOrCreateProject(ARR, 'arr')
  getOrCreateProject('claude://default/Users/jonas/projects/remote-claude', 'remote-claude')
})
afterEach(() => {
  closeProjectMemory()
  closeProjectStore()
  rmSync(dir, { recursive: true, force: true })
})

describe('dispatch tools (project-anchored)', () => {
  test('projects_overview lists every project with its brief + live counts', async () => {
    seedBrief('arr is a media indexer')
    const tools = buildDispatchToolset(
      fakeRt([{ id: 'c1', project: ARR, status: 'active', liveStatus: { state: 'working' } as never }]),
    )
    const rows = (await tools.projects_overview.execute({}, ctx)) as Array<{
      project: string
      brief: string
      live: number
    }>
    const arr = rows.find(r => r.project === 'arr')
    expect(arr?.brief).toBe('arr is a media indexer')
    expect(arr?.live).toBe(1)
    // The idle project still shows up with zero conversations.
    expect(rows.some(r => r.project === 'remote-claude' && r.live === 0)).toBe(true)
  })

  test('project_brief returns the condensed memory + live conversations for a named project', async () => {
    seedBrief('arr indexes media')
    const tools = buildDispatchToolset(
      fakeRt([
        { id: 'c1', project: ARR, status: 'active', title: 'auth work', liveStatus: { state: 'working' } as never },
      ]),
    )
    const out = (await tools.project_brief.execute({ project: 'arr' }, ctx)) as {
      project: string
      brief: string
      conversations: Array<{ conversationId: string }>
    }
    expect(out.project).toBe('arr')
    expect(out.brief).toBe('arr indexes media')
    expect(out.conversations[0].conversationId).toBe('c1')
  })

  test('project_brief on an unknown project returns a clean error', async () => {
    const tools = buildDispatchToolset(fakeRt([]))
    const out = (await tools.project_brief.execute({ project: 'does-not-exist-xyz' }, ctx)) as { error?: string }
    expect(out.error).toContain('no project matching')
  })

  test('recall finds a project by its condensed brief', async () => {
    seedBrief('arr is a sonarr/radarr media indexer')
    const tools = buildDispatchToolset(fakeRt([]))
    const hits = (await tools.recall.execute({ query: 'sonarr' }, ctx)) as Array<{ project: string }>
    expect(hits.map(h => h.project)).toContain('arr')
  })

  test('the generic spawn verb is replaced by spawn_into_project', () => {
    const tools = buildDispatchToolset(fakeRt([]))
    expect(tools.spawn).toBeUndefined()
    expect(tools.spawn_into_project).toBeDefined()
    expect(tools.list_conversations).toBeDefined() // still available (Jonas)
  })

  test('spawn_into_project rejects an unknown project cleanly', async () => {
    const tools = buildDispatchToolset(fakeRt([]))
    const out = (await tools.spawn_into_project.execute({ project: 'nope-xyz', intent: 'x', profile: null }, ctx)) as {
      error?: string
    }
    expect(out.error).toContain('no project matching')
  })
})
