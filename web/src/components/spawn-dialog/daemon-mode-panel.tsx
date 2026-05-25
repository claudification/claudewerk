/**
 * DaemonModePanel -- the NEW / RESUME config editor for a daemon launch.
 *
 * Controlled: the parent (spawn-dialog) owns the `DaemonModeFormValue`. ATTACH
 * has no config and uses DaemonRosterBrowser instead. Reuses LaunchConfigFields
 * for the model + env rows and the launch-profiles AppendSystemPromptSection
 * for the system-prompt suffix.
 */

import { LaunchConfigFields } from '@/components/launch-config-fields'
import { AppendSystemPromptSection } from '@/components/launch-profiles/editor-sections'
import type { DaemonModeFormValue } from './daemon-launch'

interface DaemonModePanelProps {
  mode: 'new' | 'resume'
  /** Which config tier to render. Basic = the everyday fields (resume id,
   *  prompt, model); Advanced = env, system-prompt suffix, sentinel-host paths,
   *  worktree. Mirrors the Interactive/Headless dialog's Basic/Advanced tabs. */
  tab: 'basic' | 'advanced'
  value: DaemonModeFormValue
  onChange: (patch: Partial<DaemonModeFormValue>) => void
}

/** Label + free-text input, mono styling matching the spawn dialog. */
function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  error?: string
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-mono text-muted-foreground">{label}</div>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        className={`w-full text-[10px] font-mono bg-surface-inset border text-foreground px-2 py-1 outline-none transition-colors ${
          error ? 'border-red-500/50 focus-visible:border-red-500' : 'border-primary/20'
        }`}
      />
      {error ? (
        <div className="text-[9px] font-mono text-red-400">{error}</div>
      ) : hint ? (
        <div className="text-[9px] text-comment leading-snug">{hint}</div>
      ) : null}
    </div>
  )
}

/** Inline absolute-path error for a settings / mcp-config path field. */
function absPathError(raw: string): string | undefined {
  const v = raw.trim()
  return v && !v.startsWith('/') ? 'Must be an absolute path (start with /)' : undefined
}

/** The first-turn prompt field. Optional for both modes: NEW supports
 *  promptless dispatch (transport reframe Phase 4), RESUME continues a session. */
function PromptField({
  mode,
  value,
  onChange,
}: {
  mode: 'new' | 'resume'
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-mono text-muted-foreground">
        Prompt <span className="text-comment">(optional)</span>
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={
          mode === 'new' ? 'First turn for the new daemon worker (optional)...' : 'Optional first turn after resume...'
        }
        className="w-full text-[10px] font-mono bg-surface-inset border border-primary/20 text-foreground px-2 py-1 outline-none resize-y"
      />
    </div>
  )
}

/** Sentinel-host config paths + the worktree branch. */
function DaemonPathFields({
  value,
  onChange,
}: {
  value: DaemonModeFormValue
  onChange: (patch: Partial<DaemonModeFormValue>) => void
}) {
  return (
    <>
      <TextField
        label="Settings path (optional)"
        value={value.settingsPath}
        onChange={v => onChange({ settingsPath: v })}
        placeholder="/abs/path/to/settings.json"
        hint="Absolute path on the sentinel host. claude --bg --settings"
        error={absPathError(value.settingsPath)}
      />
      <TextField
        label="MCP config path (optional)"
        value={value.mcpConfigPath}
        onChange={v => onChange({ mcpConfigPath: v })}
        placeholder="/abs/path/to/mcp.json"
        hint="Absolute path on the sentinel host. claude --bg --mcp-config"
        error={absPathError(value.mcpConfigPath)}
      />
      <TextField
        label="Worktree branch (optional)"
        value={value.worktreeName}
        onChange={v => onChange({ worktreeName: v })}
        placeholder="branch name"
        hint="Isolated git worktree for the worker cwd."
      />
    </>
  )
}

export function DaemonModePanel({ mode, tab, value, onChange }: DaemonModePanelProps) {
  if (tab === 'basic') {
    return (
      <div className="space-y-3">
        {mode === 'resume' && (
          <TextField
            label="Resume session id"
            value={value.resumeSessionId}
            onChange={v => onChange({ resumeSessionId: v })}
            placeholder="daemon session id to fork from"
            hint="claude --bg --resume <id>. The resumed worker forks to a fresh session that carries prior history."
          />
        )}

        <PromptField mode={mode} value={value.prompt} onChange={v => onChange({ prompt: v })} />

        {/* Model row reused from the shared launch config component. */}
        <LaunchConfigFields
          value={{ model: value.model }}
          onChange={patch => {
            if ('model' in patch) onChange({ model: patch.model ?? '' })
          }}
          show={{ model: true }}
        />
      </div>
    )
  }

  // Advanced: env, system-prompt suffix, sentinel-host config paths, worktree.
  return (
    <div className="space-y-3">
      <LaunchConfigFields
        value={{ envText: value.envText }}
        onChange={patch => {
          if ('envText' in patch) onChange({ envText: patch.envText ?? '' })
        }}
        show={{ env: true }}
      />
      <div className="text-[9px] text-comment -mt-1.5">Env is merged into the daemon worker process (claude --bg).</div>

      <AppendSystemPromptSection
        value={value.appendSystemPrompt}
        onChange={text => onChange({ appendSystemPrompt: text })}
      />

      <DaemonPathFields value={value} onChange={onChange} />
    </div>
  )
}
