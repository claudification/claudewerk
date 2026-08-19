import { describe, expect, it } from 'vitest'
import { type Candidate, resolveSpokenConversation } from './resolve-conversation'

const RC = 'claude://default/Users/jonas/projects/remote-claude'
const TEMP = 'claude://default/Users/jonas/temp'
const P2 = 'claude://default/Users/jonas/projects/growing-generations/portal2'

const c = (id: string, title: string, project: string, projectLabel?: string): Candidate => ({
  conversationId: id,
  title,
  project,
  projectLabel,
})

const FLEET: Candidate[] = [
  c('conv_a', 'batch modal improvements', RC, 'CLAUDEWERK'),
  c('conv_b', 'soundsource diagnosis', TEMP, 'Scratch/Temp'),
  c('conv_c', 'brand a11y pass', P2, 'Portal 2'),
]

const won = (spoken: string, pool = FLEET) => {
  const r = resolveSpokenConversation(spoken, pool)
  return r.ok ? r.conversation.conversationId : `ERR: ${r.error}`
}

describe('resolveSpokenConversation -- title', () => {
  it('matches an exact title', () => {
    expect(won('soundsource diagnosis')).toBe('conv_b')
  })

  it('matches a title substring', () => {
    expect(won('batch modal')).toBe('conv_a')
  })

  it('matches a title through lost punctuation', () => {
    expect(won('branda11y pass')).toBe('conv_c')
  })

  it('matches a conversation id outright', () => {
    expect(won('conv_a')).toBe('conv_a')
  })
})

describe('resolveSpokenConversation -- project name', () => {
  // The bug: the matcher scored the spoken name against the raw claude:// URI,
  // so the only name the user has ever seen or said out loud scored ZERO.
  it('matches a project by its DISPLAY LABEL', () => {
    expect(won('claudewerk')).toBe('conv_a')
  })

  it('matches a label whose punctuation speech drops', () => {
    expect(won('scratch temp')).toBe('conv_b')
    expect(won('portal 2')).toBe('conv_c')
  })

  it('still matches the URI basename when a project has no label', () => {
    const pool = [c('conv_d', 'untitled', 'claude://default/Users/jonas/projects/agent-drop')]
    expect(won('agent-drop', pool)).toBe('conv_d')
    expect(won('agent drop', pool)).toBe('conv_d')
  })

  it('prefers a title hit over another conversation project hit', () => {
    const pool = [c('conv_a', 'CLAUDEWERK rollout', TEMP, 'Scratch/Temp'), c('conv_b', 'other', RC, 'CLAUDEWERK')]
    expect(won('claudewerk', pool)).toBe('conv_a')
  })
})

describe('resolveSpokenConversation -- URI noise must not match', () => {
  // Every URI starts `claude://default/Users/jonas/projects/...`, so matching the
  // raw string made these score against the WHOLE fleet at once and the matcher
  // refused every one of them as "ambiguous". Only the project's NAME is a
  // haystack now, so the scheme, the authority and the home path are invisible.
  it.each(['default', 'users', 'jonas', 'projects'])('does not match the URI token %j', token => {
    expect(won(token)).toBe(`ERR: nothing live matches "${token}"`)
  })

  it('does not match the claude:// scheme shared by every conversation', () => {
    // Labels AND basenames chosen to not contain "claude" (`remote-claude` would
    // be a legitimate hit) -- what must not match is the scheme every URI shares.
    const pool = [c('conv_x', 'one', P2, 'Portal 2'), c('conv_y', 'two', TEMP, 'Scratch/Temp')]
    expect(won('claude', pool)).toBe('ERR: nothing live matches "claude"')
  })

  it('does match a label that genuinely contains the word', () => {
    expect(won('claude')).toBe('conv_a') // label is "CLAUDEWERK"
  })
})

describe('resolveSpokenConversation -- refusals', () => {
  it('refuses an empty name', () => {
    const r = resolveSpokenConversation('  ', FLEET)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('no conversation named')
  })

  it('refuses a tie rather than picking', () => {
    const pool = [c('conv_a', 'deploy', RC, 'CLAUDEWERK'), c('conv_b', 'deploy', TEMP, 'Scratch/Temp')]
    const r = resolveSpokenConversation('deploy', pool)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('ambiguous')
  })

  it('refuses when two conversations share a project and nothing else separates them', () => {
    const pool = [c('conv_a', 'one', RC, 'CLAUDEWERK'), c('conv_b', 'two', RC, 'CLAUDEWERK')]
    const r = resolveSpokenConversation('claudewerk', pool)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.candidates).toHaveLength(2)
  })

  it('returns candidates when nothing matches', () => {
    const r = resolveSpokenConversation('nonexistent', FLEET)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.candidates).toHaveLength(3)
  })

  it('tolerates a candidate with no project at all (dialog targets pass none)', () => {
    const pool = [c('conv_a', 'question open', '')]
    expect(won('question', pool)).toBe('conv_a')
  })
})
