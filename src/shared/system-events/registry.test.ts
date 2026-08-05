import { describe, expect, it } from 'bun:test'
import { CARD_KINDS, DESCRIBED_KINDS, HIDDEN_KINDS, kindOf, WIRE_KEYS, wireKey } from './index'

/** Every wire key resolves to a kind, and every kind is described, hidden, or a card. */
describe('registry integrity', () => {
  it('routes every wire key to a kind', () => {
    for (const key of WIRE_KEYS) {
      const [type, sub] = key.startsWith('system/') ? ['system', key.slice('system/'.length)] : [key, undefined]
      expect(kindOf({ type, subtype: sub }), `${key} resolved to no kind`).not.toBeNull()
    }
  })

  it('accounts for every kind -- described, hidden, or a card', () => {
    const accounted = new Set([...DESCRIBED_KINDS, ...HIDDEN_KINDS, ...CARD_KINDS])
    const kinds = new Set(
      WIRE_KEYS.map(key => {
        const [type, sub] = key.startsWith('system/') ? ['system', key.slice('system/'.length)] : [key, undefined]
        return kindOf({ type, subtype: sub }) as string
      }),
    )
    const orphans = [...kinds].filter(k => !accounted.has(k))
    expect(orphans, `kinds with no describer and not hidden: ${orphans.join(', ')}`).toEqual([])
  })

  it('never both hides and describes the same kind', () => {
    const both = DESCRIBED_KINDS.filter(k => HIDDEN_KINDS.has(k))
    expect(both, `hidden kinds carrying dead describers: ${both.join(', ')}`).toEqual([])
  })

  it('builds a wire key from either shape', () => {
    expect(wireKey({ type: 'system', subtype: 'api_error' })).toBe('system/api_error')
    expect(wireKey({ type: 'pr-link' })).toBe('pr-link')
    expect(wireKey({ type: 'system' })).toBe('system')
    expect(wireKey({})).toBe('')
  })

  it('maps different backend dialects of one event onto one kind', () => {
    // Claude Code, and the chat-api / ACP / opencode backends, disagree on the wire.
    expect(kindOf({ type: 'system', subtype: 'api_error' })).toBe('api-error')
    expect(kindOf({ type: 'system', subtype: 'chat_api_error' })).toBe('api-error')
    // A published PR arrives mid-stream AND as a JSONL entry.
    expect(kindOf({ type: 'system', subtype: 'code_change_published' })).toBe('code-published')
    expect(kindOf({ type: 'pr-link' })).toBe('code-published')
  })

  it('claims nothing that belongs to the message path', () => {
    expect(kindOf({ type: 'user' })).toBeNull()
    expect(kindOf({ type: 'assistant' })).toBeNull()
    expect(kindOf({ type: 'boot' })).toBeNull()
    expect(kindOf({ type: 'launch' })).toBeNull()
    expect(kindOf({ type: 'shell' })).toBeNull()
    expect(kindOf({ type: 'queue-operation' })).toBeNull()
  })
})
