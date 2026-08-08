/**
 * Fork a Claude Code session: fold one transcript into a NEW resumable one.
 *
 * The sentinel owns this because it is the only component with host filesystem
 * access. The broker never learns where a transcript lives (CWD-IS-INFORMATIONAL)
 * and never reads a ccSessionId (BOUNDARY RULE) -- it forwards an opaque
 * `sourceCcSessionId` plus a cwd and gets back a fresh id to spawn against.
 *
 * The source is opened READ-ONLY and never modified: a fork is a continuation
 * with a link back, so it is always reversible at the source.
 *
 * Proven end-to-end -- `claude --resume` accepts the synthesized chain and
 * answers correctly from the folded context. See
 * `scripts/spike-fork-supercompact.ts`.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runCompaction } from '../agent-host-common/super-compact'
import { ClaudeCodeAdapter } from '../agent-host-common/super-compact/claude-code-adapter'
import { FileReader, FileWriter } from '../agent-host-common/super-compact/io'
import type { ForkCcSessionResult } from '../shared/protocol'
import { transcriptSlug } from '../shared/transcript-path'

export interface ForkCcSessionInput {
  /** Resolved, symlink-free host path the source session ran in. */
  cwd: string
  /** Config dir of the profile that owns the source transcript. */
  configDir: string
  sourceCcSessionId: string
  /** Digest cold tool_results over this many tokens; 0 copies them verbatim. */
  digestOverTokens?: number
  tailTokenBudget?: number
  /** Injectable for tests. */
  genSessionId?: () => string
}

export type ForkOutcome =
  | { ok: true; ccSessionId: string; stats: NonNullable<ForkCcSessionResult['stats']> }
  | { ok: false; error: string }

/**
 * Fold `sourceCcSessionId` into a fresh session in the same project dir.
 *
 * Both files live under `<configDir>/projects/<slug>/`, so the fork is
 * discoverable by exactly the same `--resume` lookup CC already does -- no new
 * path convention, and the fork shows up in the session picker for free.
 */
export async function forkCcSession(input: ForkCcSessionInput): Promise<ForkOutcome> {
  const projectDir = join(input.configDir, 'projects', transcriptSlug(input.cwd))
  const sourcePath = join(projectDir, `${input.sourceCcSessionId}.jsonl`)

  if (!existsSync(sourcePath)) {
    // The most likely cause by far is a profile mismatch: CC writes the
    // transcript under the config dir of the profile that ran it, so asking the
    // wrong profile finds nothing. Say which path was tried -- an empty
    // "not found" here used to be indistinguishable from a corrupt session.
    return { ok: false, error: `Source transcript not found: ${sourcePath}` }
  }

  const newCcSessionId = (input.genSessionId ?? (() => crypto.randomUUID()))()
  const outPath = join(projectDir, `${newCcSessionId}.jsonl`)

  try {
    const result = await runCompaction(new FileReader(sourcePath), new FileWriter(outPath), new ClaudeCodeAdapter(), {
      newSessionId: newCcSessionId,
      parentRef: { sessionId: input.sourceCcSessionId, path: sourcePath },
      digestToolResultsOverTokens: input.digestOverTokens,
      tailTokenBudget: input.tailTokenBudget,
    })
    const s = result.stats
    return {
      ok: true,
      ccSessionId: newCcSessionId,
      stats: {
        beforeTokens: s.beforeTokens,
        afterTokens: s.afterTokens,
        entriesBefore: s.entriesBefore,
        entriesAfter: s.entriesAfter,
        digestedResults: s.digestedResults,
        droppedThinking: s.droppedThinking,
        collapsedReads: s.collapsedReads,
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
