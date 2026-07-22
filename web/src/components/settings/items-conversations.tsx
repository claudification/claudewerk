/** Conversation startup behavior + launch defaults. */

import { DefaultConversationPicker } from './default-conversation-picker'
import { SELECT_CLS, type SettingItem, TEXT_INPUT_CLS } from './settings-item'

// The agent-spawn default transport picker reads `defaultTransport.claude`.
// Falls back to 'claude-pty' when unset (the broker materializes that default).
function resolveDefaultTransport(server: Record<string, unknown>): string {
  const dt = server.defaultTransport as { claude?: string } | undefined
  return dt?.claude ?? 'claude-pty'
}

export const CONVERSATION_ITEMS: SettingItem[] = [
  {
    tab: 'sessions',
    group: 'Startup',
    label: 'Default conversation',
    description: 'Auto-select this project when opening the dashboard (per-device)',
    keywords: 'startup auto select home',
    render: (ctx, _ariaLabel) => (
      <DefaultConversationPicker
        value={ctx.prefs.defaultConversationCwd ?? ''}
        onChange={v => ctx.updatePrefs({ defaultConversationCwd: v })}
      />
    ),
  },
  {
    tab: 'sessions',
    group: 'Startup',
    label: 'Default view',
    description: 'What to show when selecting a conversation (per-device)',
    keywords: 'terminal tty transcript',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={ctx.prefs.defaultView ?? 'transcript'}
        onChange={e => ctx.updatePrefs({ defaultView: e.target.value as 'transcript' | 'tty' })}
        className={SELECT_CLS}
      >
        <option value="transcript">Transcript</option>
        <option value="tty">TTY</option>
      </select>
    ),
  },
  {
    tab: 'sessions',
    group: 'Launch defaults',
    label: 'Default transport (agent spawns)',
    description:
      'Transport for the claude backend on conversations spawned by agents (MCP / inter-conversation) that name no transport. Daemon = a subscription-billed claude --bg worker. The control panel spawn dialog is unaffected -- it always picks a transport.',
    keywords: 'transport daemon pty headless claude agent spawn mcp default cutover backend',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={resolveDefaultTransport(ctx.server)}
        onChange={e => ctx.setServer('defaultTransport', { claude: e.target.value })}
        className={SELECT_CLS}
      >
        <option value="claude-pty">PTY (terminal)</option>
        <option value="claude-headless">Headless (stream-json)</option>
        <option value="claude-daemon">Daemon (background worker)</option>
      </select>
    ),
  },
  {
    tab: 'sessions',
    group: 'Launch defaults',
    label: 'Default launch mode',
    description: 'Default mode when spawning/reviving conversations (per-project overrides this)',
    keywords: 'headless pty terminal launch mode spawn',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={(ctx.server.defaultLaunchMode as string) || 'headless'}
        onChange={e => ctx.setServer('defaultLaunchMode', e.target.value)}
        className={SELECT_CLS}
      >
        <option value="headless">Headless</option>
        <option value="pty">PTY (terminal)</option>
      </select>
    ),
  },
  {
    tab: 'sessions',
    group: 'Launch defaults',
    label: 'Default effort',
    description: 'Default --effort level for new conversations (per-project overrides this)',
    keywords: 'effort thinking budget low medium high xhigh max',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={(ctx.server.defaultEffort as string) || 'default'}
        onChange={e => ctx.setServer('defaultEffort', e.target.value)}
        className={SELECT_CLS}
      >
        <option value="default">Default (no flag)</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="xhigh">XHigh (Opus 4.7)</option>
        <option value="max">Max</option>
      </select>
    ),
  },
  {
    tab: 'sessions',
    group: 'Launch defaults',
    label: 'Default model',
    description: 'Default --model for new conversations (per-project overrides this)',
    keywords: 'model opus sonnet haiku claude',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="text"
        value={(ctx.server.defaultModel as string) || ''}
        onChange={e => ctx.setServer('defaultModel', e.target.value)}
        placeholder="e.g. sonnet, opus"
        className={`${TEXT_INPUT_CLS} w-40 placeholder:text-muted-foreground/50`}
      />
    ),
  },
  {
    tab: 'sessions',
    group: 'Launch defaults',
    label: 'Default OpenCode model',
    description:
      'Default model for new OpenCode conversations (per-project overrides this; empty = opencode-go/glm-5.1)',
    keywords: 'opencode model glm gpt qwen claude haiku openrouter zen go',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="text"
        value={(ctx.server.defaultOpenCodeModel as string) || ''}
        onChange={e => ctx.setServer('defaultOpenCodeModel', e.target.value)}
        placeholder="opencode-go/glm-5.1"
        spellCheck={false}
        autoCapitalize="off"
        className={`${TEXT_INPUT_CLS} w-72 placeholder:text-muted-foreground/50`}
      />
    ),
  },
]
