import { DEFAULT_VOICE_ORB_SPEED, DEFAULT_VOICE_ORB_VOICE } from '@shared/voice-orb-options'
import type { VirtualizerLabPrefs } from './virtualizer-lab'

export interface ToolDisplayPrefs {
  defaultOpen: boolean
  lineLimit: number
}

// Tools that have meaningful output to display
export const TOOL_DISPLAY_KEYS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Agent',
  'REPL',
  'MCP',
] as const
export type ToolDisplayKey = (typeof TOOL_DISPLAY_KEYS)[number]

const DEFAULT_TOOL_DISPLAY: Record<ToolDisplayKey, ToolDisplayPrefs> = {
  Bash: { defaultOpen: false, lineLimit: 10 },
  Read: { defaultOpen: false, lineLimit: 10 },
  Write: { defaultOpen: true, lineLimit: 10 },
  Edit: { defaultOpen: true, lineLimit: 0 },
  Grep: { defaultOpen: false, lineLimit: 10 },
  Glob: { defaultOpen: false, lineLimit: 10 },
  WebSearch: { defaultOpen: false, lineLimit: 15 },
  WebFetch: { defaultOpen: false, lineLimit: 15 },
  Agent: { defaultOpen: false, lineLimit: 0 },
  REPL: { defaultOpen: false, lineLimit: 20 },
  MCP: { defaultOpen: false, lineLimit: 15 },
}

export interface ControlPanelPrefs {
  showEndedConversations: boolean // show [ENDED] conversations within CWD groups (organized + unorganized)
  showInactiveByDefault: boolean
  compactMode: boolean
  showVoiceInput: boolean
  showVoiceFab: boolean
  showWsStats: boolean
  showThinking: boolean
  showContextInList: boolean
  showCostInList: boolean
  showRecapDescInList: boolean
  chatBubbles: boolean
  sessionCacheSize: number // LIFO cache: 0 = disabled, N = keep N recent conversations in memory
  sessionCacheTimeout: number // minutes before cached non-selected conversations are evicted (0 = never)
  defaultView: 'transcript' | 'tty'
  voiceHoldKey: string | null // KeyboardEvent.code for push-to-talk (e.g. 'F13', 'ScrollLock')
  keepMicOpen: boolean // keep mic stream alive permanently (eliminates cold-start latency)
  voiceLingerMs: number // how long to keep recording after releasing push-to-talk (catches trailing words)
  voiceWarmStreamMs: number // how long to keep mic stream warm after recording (0 = release immediately)
  voiceNoiseSuppression: boolean // ask the browser for noise suppression + AGC. OFF by default: on macOS/Safari it can route the mic through Apple's voice-processing unit, which ducks other media (see voice-mic-stream.ts). Flip it if the room is noisy and judge for yourself.
  /** Mic-capture engine. 'mediarecorder' (DEFAULT) streams a webm/opus (or
   *  Safari audio/mp4) container the broker hands Deepgram for NATIVE endpointing
   *  -- the path that worked. 'pcm' is the AudioWorklet raw-linear16 engine built
   *  to shave a Safari lag, but on a RAW mic it regressed dictation badly
   *  (unbounded growing ASR lag + mishearing). Opt into 'pcm' only for that
   *  Safari-lag case. Per-device. See voice-capture-shared.ts. */
  voiceCaptureEngine: 'mediarecorder' | 'pcm'
  voiceDeviceId: string // preferred audio input device ID ('' = system default)
  /** The voice ORB's tone dial (Professional | Snarky | Homicidal | Overkill).
   *  Sent with the mint; the broker narrows it and picks the persona preamble.
   *  Per-device, like every other pref here. */
  voiceOrbTone: string
  /** Voice orb speaking rate, 0.25..1.5 (OpenAI's own bounds). */
  voiceOrbSpeed: number
  /** Which OpenAI voice the orb speaks with. */
  voiceOrbVoice: string
  voiceDeviceLabel: string // last-known label for voiceDeviceId, so the picker shows the right mic name before/without a mic grant (Google-Meet-style). '' when unknown.
  chatBubbleColor: string // tailwind color class prefix (e.g. 'blue', 'teal', 'purple')
  defaultConversationCwd: string // auto-select this project on dashboard load (per-device)
  showDiag: boolean
  showStreaming: boolean
  showPerfMonitor: boolean
  /** EXPERIMENTAL: reserve estimated scrollbar height for older entries not yet
   *  loaded, so the thumb reflects full conversation length from load. Off by
   *  default -- see plan-transcript-scrollback-reservation.md. */
  scrollbackReservation: boolean
  /** Live "thinking" pill on the active turn (ephemeral, while pings arrive).
   *  detailed = sparkline + tokens/sec + count; compact = spinner + count. */
  thinkingIndicator: 'detailed' | 'compact' | 'off'
  toolDisplay: Partial<Record<ToolDisplayKey, Partial<ToolDisplayPrefs>>>
  chordTimeoutMs: number // how long to wait for second chord key before dismissing (ms)
  sanitizePaths: boolean // strip redundant `cd <project-path> &&` prefixes from displayed commands
  inputBackend: 'legacy' | 'codemirror' // editor backend for InputEditor (default legacy)
  settingsTab: SettingsTab // last active settings tab (per-device)
  theme: string // UI theme id (see lib/themes.ts)
  /** Sidebar conversation-list rendering. 'default' = full compact rows (today);
   *  'rail' = status-rail: state-colored glyph + project monogram/spine, denser.
   *  Per-device (localStorage). Toggle via the `> List view` palette command. */
  listViewMode: 'default' | 'rail'
  /** Active workspace filter. null = "All" (show every root node). */
  activeWorkspaceId: string | null
  /** Virtualizer Lab experiment knobs (Experiments settings tab). Stored as a
   *  partial so knobs added later inherit their defaults; resolve with
   *  resolveVirtualizerLab() at the point of use. {} = production behavior. */
  virtualizerLab: Partial<VirtualizerLabPrefs>
  /** Transcript scroll/measure engine. 'plain' (DEFAULT) = the non-virtualized
   *  TranscriptViewPlain (stick-to-bottom engine + browser-native scroll
   *  mechanics: scrollHeight prepend anchor, IntersectionObserver scrollback,
   *  content-visibility offscreen skipping). 'virtualized' = the legacy TanStack
   *  virtualizer (opt-in; the Virtualizer Lab experiments only apply to it).
   *  Per-device. Plan: .claude/docs/plan-transcript-non-virtualized.md. */
  transcriptRenderer: 'plain' | 'virtualized'
}

export type SettingsTab = 'general' | 'display' | 'input' | 'sessions' | 'sentinels' | 'system' | 'experiments'

const defaultPrefs: ControlPanelPrefs = {
  showEndedConversations: true,
  showInactiveByDefault: false,
  compactMode: false,
  showVoiceInput: true,
  showVoiceFab: false,
  showWsStats: false,
  showThinking: false,
  showContextInList: true,
  showCostInList: false,
  showRecapDescInList: true,
  chatBubbles: true,
  sessionCacheSize: 3,
  sessionCacheTimeout: 10,
  defaultView: 'transcript',
  voiceHoldKey: null,
  keepMicOpen: false,
  voiceLingerMs: 1500,
  voiceWarmStreamMs: 30_000,
  voiceNoiseSuppression: false,
  voiceCaptureEngine: 'mediarecorder',
  voiceDeviceId: '',
  voiceOrbTone: 'snarky',
  voiceOrbSpeed: DEFAULT_VOICE_ORB_SPEED,
  voiceOrbVoice: DEFAULT_VOICE_ORB_VOICE,
  voiceDeviceLabel: '',
  chatBubbleColor: 'blue',
  showDiag: false,
  showStreaming: true,
  showPerfMonitor: false,
  scrollbackReservation: false,
  thinkingIndicator: 'detailed',
  defaultConversationCwd: '',
  toolDisplay: {},
  chordTimeoutMs: 3000,
  sanitizePaths: true,
  inputBackend: 'legacy',
  settingsTab: 'general',
  theme: 'tokyo-night',
  listViewMode: 'default',
  activeWorkspaceId: null,
  virtualizerLab: {},
  transcriptRenderer: 'plain',
}

export function loadPrefs(): ControlPanelPrefs {
  try {
    const raw = localStorage.getItem('control-panel-prefs')
    if (raw) {
      const stored = JSON.parse(raw)
      // Legacy: `plainTranscript` was an opt-IN to plain (default TanStack).
      // Plain is now the default on every device, TanStack a deliberate opt-in
      // via `transcriptRenderer`. Drop the dead key rather than migrate -- a
      // stale `plainTranscript:false` must NOT strand a device on TanStack.
      delete stored.plainTranscript
      return { ...defaultPrefs, ...stored }
    }
  } catch {}
  return defaultPrefs
}

export function resolveToolDisplay(prefs: ControlPanelPrefs, tool: ToolDisplayKey): ToolDisplayPrefs {
  const custom = prefs.toolDisplay?.[tool]
  const defaults = DEFAULT_TOOL_DISPLAY[tool] || { defaultOpen: false, lineLimit: 10 }
  return { ...defaults, ...custom }
}
