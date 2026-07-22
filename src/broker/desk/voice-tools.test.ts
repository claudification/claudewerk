import { describe, expect, it } from 'bun:test'
import type { Conversation } from '../../shared/protocol'
import type { DispatchRuntime } from './runtime'
import {
  ACTIVE_VOICE_TOOLS,
  buildVoiceToolset,
  VOICE_ACTION_TOOLS,
  VOICE_FORBIDDEN_TOOLS,
  VOICE_MEMORY_TOOLS,
  VOICE_READ_TOOLS,
  voiceRealtimeTools,
} from './voice-tools'

/** Only the shape the toolset BUILDERS touch -- nothing here executes a tool. */
function fakeRt(): DispatchRuntime {
  return {
    store: { getAllConversations: () => [] as Conversation[] },
    callerConversationId: null,
    searchTranscripts: () => [],
  } as unknown as DispatchRuntime
}

describe('the voice contract', () => {
  it('mints the read set, the explicit actions, and the memory verbs', () => {
    expect([...ACTIVE_VOICE_TOOLS]).toEqual([...VOICE_READ_TOOLS, ...VOICE_ACTION_TOOLS, ...VOICE_MEMORY_TOOLS])
  })

  it('offers no way to END anything, and no way to ROUTE by classifier', () => {
    for (const forbidden of VOICE_FORBIDDEN_TOOLS) {
      expect(ACTIVE_VOICE_TOOLS).not.toContain(forbidden)
    }
    // The dispatcher is a STATUS surface for the orb (Jonas, 2026-07-22): a
    // spoken sentence must never be routed by a classifier, it goes direct.
    expect(ACTIVE_VOICE_TOOLS).not.toContain('dispatch')
    expect(ACTIVE_VOICE_TOOLS).not.toContain('conversation_select')
  })

  it('every mutating verb names its target explicitly -- nothing guesses', () => {
    // `say_to_conversation` resolves against what is ON SCREEN (client-local),
    // `dispatch_quest` takes a named project. Neither accepts a raw id from speech.
    expect(ACTIVE_VOICE_TOOLS).toContain('say_to_conversation')
    expect(ACTIVE_VOICE_TOOLS).toContain('dispatch_quest')
    expect(ACTIVE_VOICE_TOOLS).not.toContain('inject')
  })

  it('answers an open question only through the panel -- the server executor is a stub', () => {
    expect(ACTIVE_VOICE_TOOLS).toContain('answer_dialog')
    const { answer_dialog: tool } = buildVoiceToolset(fakeRt(), { names: ['answer_dialog'] })
    // What is open on screen is a fact only the panel holds; a server-side
    // execution would be answering a question it cannot see.
    expect(tool?.execute({}, {} as never)).toMatchObject({ clientLocal: expect.stringContaining('browser') })
  })

  it('ABSENCE IS THE GATE: no destructive verb appears on any phase list', () => {
    const everyPhase: string[] = [...ACTIVE_VOICE_TOOLS]
    for (const forbidden of VOICE_FORBIDDEN_TOOLS) {
      expect(everyPhase).not.toContain(forbidden)
    }
  })

  it('binds every contract name to a real executor (every phase)', () => {
    const all: string[] = [...ACTIVE_VOICE_TOOLS]
    const toolset = buildVoiceToolset(fakeRt(), { names: all })
    expect(Object.keys(toolset).sort()).toEqual([...all].sort())
    for (const tool of Object.values(toolset)) {
      expect(typeof tool.execute).toBe('function')
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })

  it('throws loudly on a contract name that no desk toolset provides', () => {
    expect(() => buildVoiceToolset(fakeRt(), { names: ['no_such_tool'] })).toThrow("no tool named 'no_such_tool'")
  })

  it('a runtime with no transcript search cannot mint search_transcripts', () => {
    const bare = { store: { getAllConversations: () => [] } } as unknown as DispatchRuntime
    expect(() => buildVoiceToolset(bare, { names: ['search_transcripts'] })).toThrow('search_transcripts')
  })
})

describe('derived Realtime schemas', () => {
  const all: string[] = [...ACTIVE_VOICE_TOOLS]
  const tools = voiceRealtimeTools(fakeRt(), { names: all })

  it('derives one strict function-schema per contract tool', () => {
    expect(tools.map(t => t.name).sort()).toEqual([...all].sort())
    for (const t of tools) {
      expect(t.type).toBe('function')
      expect(t.parameters.strict).toBe(true)
      expect(t.parameters.additionalProperties).toBe(false)
    }
  })

  it('required lists every property (the OpenAI strict-mode rule)', () => {
    for (const t of tools) {
      const props = Object.keys(t.parameters.properties).sort()
      expect([...t.parameters.required].sort()).toEqual(props)
    }
  })
})
