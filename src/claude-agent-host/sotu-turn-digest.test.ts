import { describe, expect, it } from 'bun:test'
import { TurnDigestCollector } from './sotu-turn-digest'

describe('TurnDigestCollector', () => {
  it('returns null when nothing meaningful was observed', () => {
    expect(new TurnDigestCollector().build()).toBeNull()
  })

  it('captures the user intent', () => {
    const c = new TurnDigestCollector()
    c.observeUserText('  add the callout parser  ')
    expect(c.build()).toEqual({ intent: 'add the callout parser' })
  })

  it('collects file-touching tool calls (Edit/Write/MultiEdit/NotebookEdit)', () => {
    const c = new TurnDigestCollector()
    c.observeAssistantContent([
      { type: 'text', text: 'doing it' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } },
      { type: 'tool_use', name: 'Write', input: { file_path: 'src/b.ts' } },
      { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: 'nb.ipynb' } },
    ])
    expect(c.build()?.touching).toEqual(['src/a.ts', 'src/b.ts', 'nb.ipynb'])
  })

  it('does NOT count Read as a touch', () => {
    const c = new TurnDigestCollector()
    c.observeAssistantContent([{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }])
    expect(c.build()).toBeNull()
  })

  it('dedupes repeated edits to the same file', () => {
    const c = new TurnDigestCollector()
    c.observeAssistantContent([{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }])
    c.observeAssistantContent([{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }])
    expect(c.build()?.touching).toEqual(['src/a.ts'])
  })

  it('surfaces a non-success result subtype', () => {
    const c = new TurnDigestCollector()
    c.observeUserText('do the thing')
    expect(c.build({ subtype: 'error_max_turns' })?.result).toBe('error_max_turns')
  })

  it('combines a non-success subtype with a trimmed result text', () => {
    const c = new TurnDigestCollector()
    expect(c.build({ subtype: 'error_during_execution', result_text: '  boom  ' })?.result).toBe(
      'error_during_execution: boom',
    )
  })

  it('uses the result text alone on success', () => {
    const c = new TurnDigestCollector()
    expect(c.build({ subtype: 'success', result_text: 'shipped phase 3' })?.result).toBe('shipped phase 3')
  })

  it('clamps long intent + result text', () => {
    const c = new TurnDigestCollector()
    c.observeUserText('x'.repeat(500))
    const d = c.build({ subtype: 'success', result_text: 'y'.repeat(500) })
    expect(d?.intent?.length).toBe(280)
    expect(d?.intent?.endsWith('...')).toBe(true)
    expect(d?.result?.length).toBe(280)
  })

  it('reset() clears intent and touched files', () => {
    const c = new TurnDigestCollector()
    c.observeUserText('first turn')
    c.observeAssistantContent([{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }])
    c.reset()
    expect(c.build()).toBeNull()
  })

  it('ignores malformed content gracefully', () => {
    const c = new TurnDigestCollector()
    c.observeAssistantContent(null)
    c.observeAssistantContent('not an array')
    c.observeAssistantContent([null, 42, { type: 'tool_use' }])
    expect(c.build()).toBeNull()
  })
})
