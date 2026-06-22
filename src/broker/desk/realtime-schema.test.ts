import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { toRealtimeTool } from './realtime-schema'
import { defineTool } from './tool-def'

describe('toRealtimeTool', () => {
  it('derives a strict function schema with all props required', () => {
    const tool = defineTool({
      description: 'do a thing',
      inputSchema: z.object({ a: z.string(), b: z.number().nullable() }),
      execute: () => null,
    })
    const rt = toRealtimeTool('thing', tool)
    expect(rt.name).toBe('thing')
    expect(rt.type).toBe('function')
    expect(rt.parameters.strict).toBe(true)
    expect(rt.parameters.additionalProperties).toBe(false)
    expect(rt.parameters.required.sort()).toEqual(['a', 'b'])
  })

  it('THROWS when an optional (.optional) field would break strict mode', () => {
    const bad = defineTool({
      description: 'bad',
      inputSchema: z.object({ a: z.string(), b: z.string().optional() }),
      execute: () => null,
    })
    expect(() => toRealtimeTool('bad', bad)).toThrow(/strict mode requires every property/)
  })

  it('nullable (not optional) keeps a field present + required', () => {
    const ok = defineTool({
      description: 'ok',
      inputSchema: z.object({ a: z.string(), b: z.string().nullable() }),
      execute: () => null,
    })
    expect(() => toRealtimeTool('ok', ok)).not.toThrow()
  })
})
