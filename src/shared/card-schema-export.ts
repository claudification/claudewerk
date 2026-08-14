/**
 * A GENERATED JSON Schema for card frontmatter -- for EDITOR COMPLETION ONLY.
 *
 * Read this before using it for anything: the artifact this emits is not the
 * source of truth and cannot be. `card-schema-keys.ts` is. Nothing in this repo
 * validates against the emitted file, and nothing should:
 *
 *   1. `frontmatter.ts` IS NOT YAML. It is a line-oriented subset -- flat
 *      `key: value`, inline `[a, b]`, no nesting, no quoting rules, no
 *      multi-line values. A YAML-schema tool pointed at a card would be checking
 *      against a parser this repo does not have, and would disagree with the
 *      board about what the file even says.
 *   2. The schema is OPEN. `additionalProperties: true` is not a convenience
 *      here, it is the whole design: the DONE-gate machine-authors `evidence_*`
 *      and the old fixed-key store silently destroyed exactly that. An editor
 *      that flagged an unknown key would be teaching the wrong lesson.
 *   3. It is regenerated, never edited. A hand-edit is drift by definition, and
 *      the header says so in the file itself.
 *
 * `number` and `date` come out as `string`, because that is what the parser
 * hands back -- claiming otherwise would make an editor mark a correct card red.
 */

import { CARD_KEYS } from './card-schema'
import type { CardKeySpec } from './card-schema-types'

interface JsonSchemaProperty {
  description: string
  type: 'string' | 'array'
  enum?: string[]
  items?: { type: 'string' }
}

/** How a declared type reads in the SUBSET, which is the only thing an editor
 *  should be told about. */
function property(spec: CardKeySpec): JsonSchemaProperty {
  const description = spec.consequence ? `${spec.doc} (if unset: ${spec.consequence})` : spec.doc
  if (spec.type === 'string[]') return { description, type: 'array', items: { type: 'string' } }
  if (spec.type === 'enum') return { description, type: 'string', enum: [...(spec.values ?? [])] }
  return { description, type: 'string' }
}

/**
 * The whole schema as a plain object. `required` lists only the keys whose
 * absence the doctor reports as WARNING or worse -- an info-level nudge is not
 * something an editor should paint red.
 */
export function cardJsonSchema(): Record<string, unknown> {
  const properties: Record<string, JsonSchemaProperty> = {}
  for (const spec of CARD_KEYS) properties[spec.key] = property(spec)
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'rclaude project board card frontmatter',
    description:
      'GENERATED from src/shared/card-schema-keys.ts -- do not edit. Editor completion only: the board parses a line-oriented SUBSET of YAML, not YAML, and unknown keys are always allowed.',
    type: 'object',
    additionalProperties: true,
    required: CARD_KEYS.filter(s => s.required && s.required.severity !== 'info').map(s => s.key),
    properties,
  }
}

/** The file contents, newline-terminated, ready to write. */
export function cardJsonSchemaText(): string {
  return `${JSON.stringify(cardJsonSchema(), null, 2)}\n`
}
