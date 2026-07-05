/**
 * NIGHTSHIFT CRASH INVESTIGATOR (plan-quest-engine.md §6d).
 *
 * When a night worker exits ABNORMALLY (cc-exit-crash) with attempts left, the
 * guardian triages the crash BEFORE any retry. Triage has two layers:
 *
 *  1. DETERMINISTIC hint match (`crash-hints.ts`) -- the codified known-cause
 *     catalog yields the verdict + remedy with NO LLM. This is what the guardian
 *     acts on, keeping the retry/terminal decision LLM-free (§6c spirit).
 *  2. An INVESTIGATOR LEG -- a cheap haiku, headless, read-only worker spawned
 *     with the FULL crash context + the whole hint catalog in its prompt. It is
 *     fire-and-forget: it deepens the diagnosis + annotates the card for the
 *     next incident (lessons-learned), and is the seam a later phase upgrades to
 *     return the verdict itself.
 *
 * The broker never parses the crash `cwd`/paths for logic (CWD IS
 * INFORMATIONAL): they ride into the investigator prompt opaquely as context.
 */

import { formatHintCatalog, matchCrashHint } from '../shared/crash-hints'
import type { InvestigatorVerdict } from '../shared/protocol'
import type { SpawnCallerContext } from '../shared/spawn-permissions'
import type { ConversationStore } from './conversation-store'
import { getGlobalSettings } from './global-settings'
import { getProjectSettings } from './project-settings'
import { dispatchSpawn } from './spawn-dispatch'

/** Trusted, autonomous caller -- mirrors the orchestrator's NIGHTSHIFT_CALLER. */
const INVESTIGATOR_CALLER: SpawnCallerContext = {
  kind: 'mcp',
  hasSpawnPermission: true,
  trustLevel: 'trusted',
  callerProject: null,
}

/** Everything the investigator needs to triage one crash. Assembled by the
 *  guardian from the ended conversation + its terminationDetail; paths are
 *  passthrough context only (never broker logic). */
export interface CrashContext {
  project: string
  runId: string
  taskId: string
  conversationId: string
  profile?: string
  /** CC exit code, when the host reported one. */
  exitCode?: number
  /** Free-form termination note (e.g. "stdin EOF after CC exited"). */
  exitNote?: string
  /** Tail of the worker's transcript / last error, for signature matching. */
  transcriptTail?: string
  /** Worker's working directory + worktree branch (opaque passthrough). */
  cwd?: string
  worktree?: string
  /** Attempts already spent on this task (frontmatter counter). */
  attempts: number
  /** The hard per-task attempt cap. */
  attemptCap: number
}

/** The guardian-facing triage result. The wire `InvestigatorVerdict` is just the
 *  enum; this carries the matched hint + remedy the retry applies. */
export interface InvestigatorResult {
  verdict: InvestigatorVerdict
  /** Matched hint catalog key, when a known cause was recognized. */
  hintKey?: string
  /** The correcting action for the retry (from the hint), when known. */
  remedy?: string
  reason: string
}

/** The assembled crash text hint-matching runs against (note + transcript tail). */
function crashSignatureText(ctx: CrashContext): string {
  return [ctx.exitNote, ctx.transcriptTail].filter(Boolean).join('\n')
}

/**
 * The investigator leg's prompt: the crash context + the FULL hint catalog +
 * the read-only, verdict-shaped mission. Pure + deterministic so it is unit
 * asserted (the packet's Verify: "assert the prompt contains the hint catalog +
 * crash context").
 */
export function buildInvestigatorPrompt(ctx: CrashContext): string {
  const contextLines = [
    `- task: ${ctx.taskId} (run ${ctx.runId}, project ${ctx.project})`,
    `- crashed conversation: ${ctx.conversationId}`,
    ctx.profile ? `- profile: ${ctx.profile}` : '',
    ctx.exitCode !== undefined ? `- exit code: ${ctx.exitCode}` : '',
    ctx.cwd ? `- cwd: ${ctx.cwd}` : '',
    ctx.worktree ? `- worktree branch: ${ctx.worktree}` : '',
    `- attempts so far: ${ctx.attempts} of ${ctx.attemptCap}`,
    ctx.exitNote ? `- exit note: ${ctx.exitNote}` : '',
  ].filter(Boolean)

  return [
    `You are the NIGHTSHIFT CRASH INVESTIGATOR. A night worker exited abnormally. Your mission is READ-ONLY triage: determine WHY it crashed and whether a retry can succeed. Do NOT fix code, do NOT run the task, do NOT modify the worktree.`,
    `## Crash context`,
    contextLines.join('\n'),
    `## Last output / error`,
    ctx.transcriptTail?.trim() ? '```\n' + ctx.transcriptTail.trim() + '\n```' : '(no transcript tail captured)',
    `## Known-cause hint catalog`,
    `Match the crash against these known causes. If one fits, the retry MUST apply its remedy -- a blind re-run would hit the same wall.`,
    formatHintCatalog(),
    `## Your verdict`,
    `Decide: is this crash \`retryable\` (a fresh leg, with the remedy applied if a hint matched) or \`fatal\` (retrying cannot help)? State the verdict, the matched hint key (or "none"), and one line of reasoning. If you recognize a NEW recurring crash cause not in the catalog, describe its signature + remedy so it can be added.`,
  ].join('\n\n')
}

/**
 * Triage a crash. DETERMINISTIC verdict from the hint catalog (no LLM in the
 * decision), plus a fire-and-forget investigator leg spawned with the full
 * prompt for the deeper, card-annotating diagnosis.
 *
 * Verdict rule:
 *  - a matched hint  -> `retryable` WITH its remedy (recreate worktree / respawn
 *    at root, etc). The hint is exactly the "don't blind-retry, do X instead".
 *  - no match        -> `retryable` with no remedy (a plain fresh respawn). The
 *    hard attempt cap (enforced by the caller) is the backstop against loops.
 *
 * The spawn is injected via `spawn` so tests stub it; the default runs a haiku
 * headless read-only worker at the project root (never the dead worktree).
 */
export async function investigateCrash(
  store: ConversationStore,
  ctx: CrashContext,
  spawn: (store: ConversationStore, ctx: CrashContext) => Promise<void> = spawnCrashInvestigator,
): Promise<InvestigatorResult> {
  const match = matchCrashHint(crashSignatureText(ctx))

  // Spawn the advisory leg (fire-and-forget). A spawn failure must NEVER block
  // the deterministic verdict -- the retry/terminal decision stands on the hint
  // match alone.
  void spawn(store, ctx).catch(err =>
    console.warn(`[nightshift-guardian] investigator spawn failed task=${ctx.taskId}: ${(err as Error).message}`),
  )

  if (match) {
    return {
      verdict: 'retryable',
      hintKey: match.key,
      remedy: match.hint.remedy,
      reason: `known cause [${match.key}]: ${match.hint.hint}`,
    }
  }
  return {
    verdict: 'retryable',
    reason: 'crash cause not in catalog -- fresh respawn (attempt cap is the backstop)',
  }
}

/** Spawn the read-only investigator leg. Haiku, headless, at the PROJECT ROOT
 *  (not the crashed worktree, which may be gone). Fire-and-forget -- the leg
 *  annotates the card; the guardian's verdict does not wait on it. The default
 *  `spawn` for {@link investigateCrash}. */
async function spawnCrashInvestigator(store: ConversationStore, ctx: CrashContext): Promise<void> {
  const res = await dispatchSpawn(
    {
      cwd: ctx.project,
      prompt: buildInvestigatorPrompt(ctx),
      headless: true,
      model: 'haiku',
      permissionMode: 'dontAsk',
      name: `[ns investigate] ${ctx.taskId}`.slice(0, 80),
    },
    {
      conversationStore: store,
      getProjectSettings,
      getGlobalSettings,
      callerContext: INVESTIGATOR_CALLER,
      rendezvousCallerConversationId: null,
      bypassApprovalGate: true,
    },
  )
  if (res.ok) {
    console.log(
      `[nightshift-guardian] investigator spawned task=${ctx.taskId} conv=${res.conversationId.slice(0, 8)} run=${ctx.runId}`,
    )
  } else {
    console.warn(`[nightshift-guardian] investigator spawn declined task=${ctx.taskId}: ${res.error}`)
  }
}
