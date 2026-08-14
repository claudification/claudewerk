#!/usr/bin/env bun
/**
 * Emit the card frontmatter JSON Schema, for editor completion.
 *
 *   bun run board:schema
 *   bun run board:schema > .vscode/card-schema.json
 *
 * GENERATED ARTIFACT. `src/shared/card-schema-keys.ts` is the source of truth
 * and ships inside the frozen bun bundle, which is the entire reason the
 * registry is TypeScript and not a `.yml` sitting next to a board. Nothing
 * validates against what this prints -- the board parses a line-oriented SUBSET
 * of YAML, so a real YAML-schema tool would be checking against a parser this
 * repo does not have. Unknown keys are ALWAYS allowed.
 */

import { cardJsonSchemaText } from '../src/shared/card-schema-export'

const USAGE = `usage: bun run board:schema

Prints the schema to stdout -- redirect it wherever your editor wants it.

Generated from src/shared/card-schema-keys.ts. Editor completion only: it is
never the source of truth and nothing validates against it.`

function main(): number {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  process.stdout.write(cardJsonSchemaText())
  return 0
}

process.exit(main())
