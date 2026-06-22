import { describe, expect, it } from 'bun:test'
import { dispatchToolSchemas } from './tools'
import { voiceTools } from './voice-tools'

describe('voice tool contract (derived from the one tool set)', () => {
  it('derives one Realtime tool per dispatcher tool schema', () => {
    expect(voiceTools.map(t => t.name).sort()).toEqual(Object.keys(dispatchToolSchemas).sort())
  })

  it('includes the dispatch verbs + threads + screen control', () => {
    const names = voiceTools.map(t => t.name)
    expect(names).toContain('dispatch')
    expect(names).toContain('conversation_select')
    expect(names).toContain('confirm_expensive')
    expect(names).toContain('control_screen')
    expect(names).toContain('list_threads')
  })

  it('every derived tool is a strict function schema', () => {
    for (const t of voiceTools) {
      expect(t.type).toBe('function')
      expect(t.parameters.strict).toBe(true)
      expect(t.parameters.additionalProperties).toBe(false)
    }
  })

  it('required lists every property (OpenAI strict-mode rule)', () => {
    for (const t of voiceTools) {
      const props = Object.keys(t.parameters.properties).sort()
      expect([...t.parameters.required].sort()).toEqual(props)
    }
  })
})
