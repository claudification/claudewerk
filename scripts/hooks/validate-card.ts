#!/usr/bin/env bun
/**
 * PostToolUse hook -- warn an agent the moment it writes a bad board card.
 *
 * Wire it up in `.claude/settings.json`:
 *
 *   "PostToolUse": [{
 *     "matcher": "Write|Edit|MultiEdit",
 *     "hooks": [{ "type": "command",
 *                 "command": "bun run \"$CLAUDE_PROJECT_DIR\"/scripts/hooks/validate-card.ts" }]
 *   }]
 *
 * Exit 2 hands stderr back to the model, which is the whole point: the agent
 * that just wrote the card gets told what is wrong with it while it still has
 * the context to fix it. Nothing is blocked -- the write already happened.
 *
 * FAILS OPEN, ALWAYS. A validator that breaks a session because a board is in a
 * shape it did not expect is worse than no validator, so every unexpected
 * condition exits 0 in silence. The logic is in `src/shared/project-card-hook.ts`
 * (pure, tested); this file is only the shell that talks to the process.
 */

import { existsSync, readFileSync } from 'node:fs'
import { cardWriteTarget, checkWrittenCard } from '../../src/shared/project-card-hook'
import { findingLines } from '../../src/shared/project-doctor-cli'
import { cardPath, listCardIds } from '../../src/shared/project-store'

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function main(payload: Record<string, unknown>): number {
  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>
  const target = cardWriteTarget(String(payload.tool_name ?? ''), String(toolInput.file_path ?? ''))
  if (!target) return 0

  const findings = checkWrittenCard(target, {
    readFile: (root, id) => {
      const abs = cardPath(root, id, false)
      return existsSync(abs) ? readFileSync(abs, 'utf8') : null
    },
    listIds: listCardIds,
  })
  if (findings.length === 0) return 0

  console.error(`Board card \`${target.id}\` has ${findings.length} problem(s):`)
  for (const line of findings.flatMap(findingLines)) console.error(line)
  console.error('\nFix them in the card you just wrote. (`bun run board:doctor` checks the whole board.)')
  return 2
}

try {
  const raw = await readStdin()
  process.exit(raw.trim() ? main(JSON.parse(raw)) : 0)
} catch {
  process.exit(0) // fail open -- never break a session over a health check
}
