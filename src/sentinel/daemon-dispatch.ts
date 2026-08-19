/**
 * Pure helpers for the sentinel's daemon-worker dispatch path.
 *
 * `index.ts` boots the sentinel on import, so the side-effect-free decisions of
 * the daemon launch flow -- the `DispatchSpec` assembly, the per-spawn env
 * bundle, the settings/mcp path validation, and the ATTACH-mode presence check
 * -- are extracted here so they are unit-testable without launching anything.
 * `index.ts` keeps the actual socket I/O (`dispatch()`) and calls into these.
 *
 * TRANSPORT REFRAME PHASE 4: NEW/RESUME no longer shell out to `claude --bg`.
 * The sentinel mints the worker identity (short / nonce / sessionId) and sends
 * a typed `DispatchSpec` over the daemon control socket (`source:'fleet'`).
 * The dispatch op is live-verified -- promptless dispatch, `--model` and the
 * other claude flags ride in `launch.args`, and the dispatch-supplied
 * `sessionId` becomes the worker's ccSessionId (see
 * `scripts/spike-dispatch-phase4.ts` + plan § 7.1 / § 5 Phase 4).
 *
 * See `.claude/docs/plan-daemon-launch-ux.md` Section 5.2 (the three-mode
 * dispatch table) and `.claude/docs/cc-daemon-control-protocol.md` § 3 / § 5.5
 * (the dispatch op + the DispatchSpec wire shape).
 */
import { TURN_SUMMARY_ENV } from '../claude-agent-host/turn-summary'
import type { DaemonResponse, DispatchLaunch, DispatchSpec } from '../shared/cc-daemon/types'
import { THINKING_DISPLAY_FLAG, thinkingDisplayValue } from '../shared/thinking-display'

/** Daemon launch mode. ATTACH never dispatches a worker. */
export type DaemonLaunchMode = 'new' | 'resume' | 'attach'

/** The two modes that dispatch a worker (and so accept config injection). */
export type DaemonDispatchMode = 'new' | 'resume'

/**
 * RESUME fork policy. Phase 4 live spike (`scripts/spike-dispatch-phase4.ts`)
 * DECISION: claudewerk resumes with `fork:true` -- a faithful 1:1 cutover of
 * the legacy `claude --bg --resume` always-fork semantics that the production
 * session-observer + transcript-bridge and the smoke harness's RESUME
 * continuity assertion already rely on. The fork flag does NOT change the
 * worker's reported sessionId (claudewerk supplies it in the dispatch either
 * way), so the original fork:false "preserved sessionId" motivation is moot.
 * `fork:false` (in-place continuation) stays available in the DispatchSpec type
 * for a future dedicated continuity spike.
 */
const RESUME_FORK = true

/** Whether a launch mode dispatches a worker. ATTACH does not. */
export function modeDispatchesWorker(mode: DaemonLaunchMode): boolean {
  return mode !== 'attach'
}

/**
 * Slugify a conversation name into a `cw-`-prefixed daemon job name (rides into
 * the DispatchSpec `seed.name`, surfacing on the JobRecord + `claude agents`
 * UI). Non-alphanumeric runs collapse to a single hyphen; capped at 40 chars.
 */
export function daemonJobName(name: string): string {
  return `cw-${name.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40)}`
}

export interface DispatchSpecOpts {
  /** Launch mode -- 'new' or 'resume'. ATTACH must not reach this builder. */
  mode: DaemonDispatchMode
  /** 8-hex worker short id, minted by the caller. */
  short: string
  /** 8-hex client nonce, minted by the caller. */
  nonce: string
  /** The worker's ccSessionId -- minted (32-hex) by the caller for a NEW/RESUME dispatch. */
  sessionId: string
  /** Worker cwd. */
  cwd: string
  /** Initial prompt. REQUIRED for new (caller validates); OPTIONAL for resume. */
  prompt?: string
  /** Daemon session id to resume from. RESUME only. */
  resumeSessionId?: string
  /** Model -- `--model <model>` in the worker argv. */
  model?: string
  /** Conversation name -- slugified into `seed.name`. */
  name?: string
  /** Absolute path to a settings JSON -- `--settings <path>`. */
  settingsPath?: string
  /** Absolute path to an MCP config JSON -- `--mcp-config <path>`. */
  mcpConfigPath?: string
  /** Sentinel-computed host MCP config (Phase 3b). Rides as the FIRST
   *  `--mcp-config` value; CC's flag is variadic and merges, so a caller's
   *  `mcpConfigPath` is still appended after it. */
  hostMcpConfigPath?: string
  /** Text appended to the system prompt -- `--append-system-prompt <text>`. */
  appendSystemPrompt?: string
  /** Readable thinking summaries vs CC's redacted (empty) thinking blocks.
   *  `undefined` resolves to the ON default. The daemon worker is forked by
   *  CC's own supervisor, so it never sees the agent host's env -- the choice
   *  must ride in the worker ARGV. See src/shared/thinking-display.ts. */
  thinkingSummaries?: boolean
  /** Worker env delta (profile env + per-spawn env + CLAUDE_CONFIG_DIR). The
   *  daemon applies it over its own base env -- pass only the deltas. */
  env?: Record<string, string>
}

/**
 * Assemble the worker `claude` flag argv (NO prompt, NO --resume). The daemon
 * adds `--resume <sessionId>` itself for resume mode and reuses these flags on
 * respawn. Flag order mirrors the legacy `claude --bg` builder:
 *
 *   [--model <m>] [--settings <path>] [--mcp-config <path>] [--append-system-prompt <text>]
 */
function buildWorkerFlags(opts: DispatchSpecOpts): string[] {
  const flags: string[] = []
  const push = (flag: string, value: string | undefined): void => {
    if (value) flags.push(flag, value)
  }
  push('--model', opts.model)
  // Opt-IN only: `omitted` is already CC's default, so "summaries off" pushes no
  // flag at all. Mirrors the agent host (cli-args.ts) exactly.
  const thinkingDisplay = thinkingDisplayValue(opts.thinkingSummaries)
  push(THINKING_DISPLAY_FLAG, thinkingDisplay === 'summarized' ? thinkingDisplay : undefined)
  push('--settings', opts.settingsPath)
  // CC's `--mcp-config` is variadic + merges. The host config (Phase 3b) leads;
  // a caller-supplied mcpConfigPath follows. Single flag, multiple values --
  // mirrors the claude host's `buildMcpConfigArgs`.
  const mcpPaths = [opts.hostMcpConfigPath, opts.mcpConfigPath].filter((p): p is string => typeof p === 'string')
  if (mcpPaths.length > 0) flags.push('--mcp-config', ...mcpPaths)
  push('--append-system-prompt', opts.appendSystemPrompt)
  return flags
}

/** Append the prompt as a trailing positional when it has non-whitespace content. */
function withPrompt(flags: string[], prompt: string | undefined): string[] {
  return prompt?.trim() ? [...flags, prompt] : [...flags]
}

/** Build the `launch` discriminator: resume (fork:true) or fresh prompt. */
function buildLaunch(opts: DispatchSpecOpts, flags: string[]): DispatchLaunch {
  const args = withPrompt(flags, opts.prompt)
  if (opts.mode === 'resume') {
    return { mode: 'resume', sessionId: opts.resumeSessionId as string, fork: RESUME_FORK, flagArgs: args }
  }
  return { mode: 'prompt', args }
}

/** Build the `seed` metadata: the prompt as intent (with a mode-specific fallback) + the slugified name. */
function buildSeed(opts: DispatchSpecOpts): { intent: string; name?: string } {
  const intent = opts.prompt?.trim() || (opts.mode === 'resume' ? 'resume' : 'claudewerk')
  const name = opts.name ? daemonJobName(opts.name) : undefined
  return name ? { intent, name } : { intent }
}

/**
 * Assemble the `DispatchSpec` for a NEW or RESUME daemon dispatch. Pure -- no
 * I/O. `source:'fleet'` marks claudewerk provenance (not shell/slash/spare/
 * respawn). The worker `claude` flags ride in `launch.args` (NEW) /
 * `launch.flagArgs` (RESUME) with the prompt as the trailing positional; the
 * same flags ride in `respawnFlags` so a daemon respawn re-applies them.
 */
export function buildDispatchSpec(opts: DispatchSpecOpts): DispatchSpec {
  if (opts.mode === 'resume' && !opts.resumeSessionId?.trim()) {
    throw new Error('buildDispatchSpec: resume mode requires a non-empty resumeSessionId')
  }
  const flags = buildWorkerFlags(opts)
  return {
    short: opts.short,
    nonce: opts.nonce,
    sessionId: opts.sessionId,
    createdAt: Date.now(),
    source: 'fleet',
    cwd: opts.cwd,
    launch: buildLaunch(opts, flags),
    // TURN_SUMMARY_ENV first so a caller's env still wins. The daemon worker is
    // forked by CC's own supervisor and never sees the agent host's env, so the
    // classifier opt-in that stream-backend sets for a direct spawn would be
    // silently absent here -- and the daemon path is how most conversations
    // start. See src/claude-agent-host/turn-summary.ts.
    env: { ...TURN_SUMMARY_ENV, ...(opts.env ?? {}) },
    isolation: 'none',
    respawnFlags: flags,
    seed: buildSeed(opts),
  }
}

/** Outcome of a pre-dispatch / pre-attach validation -- ok, or a fail reason. */
export interface DaemonDispatchCheck {
  ok: boolean
  error?: string
}

/**
 * Validate the optional `--settings` / `--mcp-config` paths exist on the
 * sentinel host before a NEW/RESUME dispatch. `exists` is injected so this is
 * unit-testable; `index.ts` passes `existsSync`. Returns the first failure.
 */
export function validateDaemonConfigPaths(
  paths: { settingsPath?: string; mcpConfigPath?: string },
  exists: (path: string) => boolean,
): DaemonDispatchCheck {
  const labelled: Array<[string, string | undefined]> = [
    ['--settings', paths.settingsPath],
    ['--mcp-config', paths.mcpConfigPath],
  ]
  for (const [flag, path] of labelled) {
    if (path && !exists(path)) {
      return { ok: false, error: `daemon spawn: ${flag} path not found on the sentinel host: ${path}` }
    }
  }
  return { ok: true }
}

/**
 * Decide whether an ATTACH-mode spawn may proceed, given the `has(short)`
 * response from the daemon control socket. ATTACH fails the spawn when the
 * worker is not present in the daemon roster (`has` reported an error, or
 * `present !== true`). Pure -- the caller performs the socket I/O.
 */
export function evaluateAttachPresence(resp: DaemonResponse, short: string): DaemonDispatchCheck {
  if (resp.ok === false) {
    return {
      ok: false,
      error: `daemon attach: worker ${short} not found (has -> ${resp.code ?? 'error'}: ${resp.error})`,
    }
  }
  if (resp.present !== true) {
    return {
      ok: false,
      error:
        `daemon attach: worker ${short} is not present in the daemon roster ` +
        `(has -> present=${String(resp.present)}, alive=${String(resp.alive)})`,
    }
  }
  return { ok: true }
}
