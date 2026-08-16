import { describe, expect, it } from 'vitest'
import type { Conversation, ProjectSettings } from '@/lib/types'
import { type FilterState, filterConversations } from './batch-filter'

const TEMP = 'claude://default/Users/jonas/temp'
const RC = 'claude://default/Users/jonas/projects/remote-claude'
const WT = `${RC}/.claude/worktrees/batch-modal-cleanup`

const SETTINGS: Record<string, ProjectSettings> = {
  [TEMP]: { label: 'Scratch/Temp' } as ProjectSettings,
  [RC]: { label: 'CLAUDEWERK' } as ProjectSettings,
}

const conv = (project: string, over: Partial<Conversation> = {}): Conversation =>
  ({ id: `c-${project}-${over.title ?? ''}`, project, status: 'idle', title: 'untitled', ...over }) as Conversation

const ANY: FilterState = { project: '', status: 'any', sentinel: '', text: '' }

describe('filterConversations -- project filter', () => {
  const rows = [conv(TEMP, { title: 'soundsource diagnosis' }), conv(RC, { title: 'feat: batch cleanup' })]

  it('matches a project by its DISPLAY LABEL, not just the claude:// URI', () => {
    // The bug: `Scratch/Temp` lives at .../temp, so a raw-URI match found nothing
    // and the project the user sees everywhere else vanished from batch.
    expect(filterConversations(rows, { ...ANY, project: 'scratch' }, SETTINGS)).toHaveLength(1)
    expect(filterConversations(rows, { ...ANY, project: 'Scratch/Temp' }, SETTINGS)).toHaveLength(1)
    expect(filterConversations(rows, { ...ANY, project: 'claudewerk' }, SETTINGS)).toHaveLength(1)
  })

  it('still matches by raw URI path segment', () => {
    expect(filterConversations(rows, { ...ANY, project: 'jonas/temp' }, SETTINGS)).toHaveLength(1)
    expect(filterConversations(rows, { ...ANY, project: 'remote-claude' }, SETTINGS)).toHaveLength(1)
  })

  it('matches a worktree conversation by its PARENT project label', () => {
    const wt = [conv(WT, { title: 'worktree conv' })]
    expect(filterConversations(wt, { ...ANY, project: 'claudewerk' }, SETTINGS)).toHaveLength(1)
  })

  it('falls back to the URI-derived label when the project has no settings entry', () => {
    const rows2 = [conv('claude://default/Users/jonas/projects/agent-drop')]
    expect(filterConversations(rows2, { ...ANY, project: 'agent-drop' }, {})).toHaveLength(1)
  })

  it('returns nothing for a label that matches no project', () => {
    expect(filterConversations(rows, { ...ANY, project: 'nope' }, SETTINGS)).toHaveLength(0)
  })
})

describe('filterConversations -- text search', () => {
  const rows = [conv(TEMP, { title: 'soundsource diagnosis' }), conv(RC, { title: 'feat: batch cleanup' })]

  it('matches on title', () => {
    expect(filterConversations(rows, { ...ANY, text: 'soundsource' }, SETTINGS)).toHaveLength(1)
  })

  it('matches on the display label too', () => {
    expect(filterConversations(rows, { ...ANY, text: 'claudewerk' }, SETTINGS)).toHaveLength(1)
  })
})

describe('filterConversations -- status and sentinel', () => {
  it('never returns ended conversations, whatever the status filter', () => {
    const rows = [conv(TEMP, { status: 'ended' }), conv(TEMP, { status: 'idle' })]
    expect(filterConversations(rows, ANY, SETTINGS)).toHaveLength(1)
    expect(filterConversations(rows, { ...ANY, status: 'idle' }, SETTINGS)).toHaveLength(1)
  })

  it('live keeps only active conversations', () => {
    const rows = [conv(TEMP, { status: 'active' }), conv(TEMP, { status: 'idle' })]
    expect(filterConversations(rows, { ...ANY, status: 'live' }, SETTINGS)).toHaveLength(1)
  })

  it('matches a sentinel by id or alias', () => {
    const rows = [
      conv(TEMP, { hostSentinelId: 'snt_abc', hostSentinelAlias: 'studio' }),
      conv(TEMP, { hostSentinelId: 'snt_xyz' }),
    ]
    expect(filterConversations(rows, { ...ANY, sentinel: 'studio' }, SETTINGS)).toHaveLength(1)
    expect(filterConversations(rows, { ...ANY, sentinel: 'snt_xyz' }, SETTINGS)).toHaveLength(1)
  })
})
