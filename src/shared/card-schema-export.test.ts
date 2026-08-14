import { describe, expect, test } from 'bun:test'
import { CARD_KEYS } from './card-schema'
import { cardJsonSchema, cardJsonSchemaText } from './card-schema-export'

describe('the generated editor schema', () => {
  const schema = cardJsonSchema()
  const properties = schema.properties as Record<string, { description: string; type: string; enum?: string[] }>

  test('it is OPEN -- an unknown key is allowed, forever, by construction', () => {
    expect(schema.additionalProperties).toBe(true)
  })

  test('it says out loud that it is generated and not the source of truth', () => {
    expect(String(schema.description)).toContain('GENERATED')
    expect(String(schema.description)).toContain('do not edit')
  })

  test('every declared key is described', () => {
    for (const spec of CARD_KEYS) expect(properties[spec.key].description).toContain(spec.doc)
  })

  test('number and date are declared as strings -- that is what the parser returns', () => {
    expect(properties.evidence_commits.type).toBe('string')
    expect(properties.created.type).toBe('string')
  })

  test('only warning-or-worse keys are required -- an editor must not paint info red', () => {
    expect(schema.required).toEqual(['status'])
  })

  test('the text round-trips as JSON and ends with a newline', () => {
    const text = cardJsonSchemaText()
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(schema)
  })
})
