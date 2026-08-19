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

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runCompaction } from '../agent-host-common/super-compact'
import { ClaudeCodeAdapter } from '../agent-host-common/super-compact/claude-code-adapter'
import { FileReader, FileWriter } from '../agent-host-common/super-compact/io'
import type { ForkCcSessionResult, ForkPoint } from '../shared/protocol'
import { transcriptSlug } from '../shared/transcript-path'

export interface ForkCcSessionInput {
  /** Resolved, symlink-free host path the source session ran in. */
  cwd: string
  /**
   * Where the fork will be LAUNCHED, if not `cwd`. CC derives the transcript
   * directory from its launch cwd, so a fork destined for a worktree must be
   * written under the worktree's directory or `--resume` will not find it.
   */
  targetCwd?: string
  /** Config dir of the profile that owns the source transcript. */
  configDir: string
  sourceCcSessionId: string
  /** Opaque provenance text for the top of the fold's preamble. */
  provenanceBlock?: string
  /** Digest cold tool_results over this many tokens; 0 copies them verbatim. */
  digestOverTokens?: number
  tailTokenBudget?: number
  /**
   * Fold only one side of a boundary entry. Omitted = fold from HEAD.
   *
   * Note what is NOT here: summarizing the discarded slice. That runs in the
   * BROKER, against its own copy of the transcript, and arrives already rendered
   * inside `provenanceBlock` -- the sentinel has host filesystem access, not a
   * model client, and giving it one to serve a checkbox would be the wrong seam.
   */
  forkPoint?: ForkPoint
  /** Injectable for tests. */
  genSessionId?: () => string
}

export type ForkOutcome =
  | {
      ok: true
      ccSessionId: string
      stats: NonNullable<ForkCcSessionResult['stats']>
      cut?: NonNullable<ForkCcSessionResult['cut']>
    }
  | { ok: false; error: string }

/**
 * Fold `sourceCcSessionId` into a fresh session in the same project dir.
 *
 * Both files live under `<configDir>/projects/<slug>/`, so the fork is
 * discoverable by exactly the same `--resume` lookup CC already does -- no new
 * path convention, and the fork shows up in the session picker for free.
 */
export async function forkCcSession(input: ForkCcSessionInput): Promise<ForkOutcome> {
  const projectsRoot = join(input.configDir, 'projects')
  const sourceDir = join(projectsRoot, transcriptSlug(input.cwd))
  const sourcePath = join(sourceDir, `${input.sourceCcSessionId}.jsonl`)

  // Retargeting writes the fork under the directory CC will look in once it is
  // launched THERE -- not next to the source. The directory may not exist yet
  // (the worktree is created at spawn time), so it is created here.
  const targetDir = input.targetCwd ? join(projectsRoot, transcriptSlug(input.targetCwd)) : sourceDir

  if (!existsSync(sourcePath)) {
    // The most likely cause by far is a profile mismatch: CC writes the
    // transcript under the config dir of the profile that ran it, so asking the
    // wrong profile finds nothing. Say which path was tried -- an empty
    // "not found" here used to be indistinguishable from a corrupt session.
    return { ok: false, error: `Source transcript not found: ${sourcePath}` }
  }

  const newCcSessionId = (input.genSessionId ?? (() => crypto.randomUUID()))()
  const outPath = join(targetDir, `${newCcSessionId}.jsonl`)

  try {
    mkdirSync(targetDir, { recursive: true })
    const result = await runCompaction(
      new FileReader(sourcePath),
      new FileWriter(outPath),
      new ClaudeCodeAdapter(),
      {
        newSessionId: newCcSessionId,
        parentRef: { sessionId: input.sourceCcSessionId, path: sourcePath },
        provenanceBlock: input.provenanceBlock,
        digestToolResultsOverTokens: input.digestOverTokens,
        tailTokenBudget: input.tailTokenBudget,
        cutAt: input.forkPoint,
      },
    )
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
      ...(input.forkPoint ? { cut: result.cut } : {}),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
