import { DEFAULT_VOICE_ORB_SPEED, DEFAULT_VOICE_ORB_VOICE } from '@shared/voice-orb-options'
import { DEFAULT_STT_MODEL } from '@/hooks/voice-stt-models'
import type { PlainRendererLabPrefs } from './plain-renderer-lab'
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
  /**
   * Stream mic audio from the browser straight to the stt-proxy Worker at the
   * nearest Cloudflare colo, with the broker out of the audio path entirely (it
   * only signs a short-lived token). ON BY DEFAULT.
   *
   * The alternative -- `false` -- relays audio through the broker, which is the
   * old path. It is kept only as an escape hatch: the broker is milliseconds away
   * on the home LAN but a round trip to the owner's house from anywhere else,
   * whereas the Cloudflare edge measures ~45ms from anywhere in the world.
   * Settings > Voice has a latency probe so the choice can be made on numbers
   * rather than belief.
   */
  voiceDirectToDeepgram: boolean
  /** Which speech model the stt-proxy Worker should use ('flux' | 'nova-3').
   *  This also decides what the browser CAPTURES with -- flux is raw-PCM-only
   *  and silently returns nothing when fed a container. See voice-stt-models. */
  voiceSttModel: string
  /** flux `eot_threshold`: how sure the model must be that the speaker finished
   *  before it closes a turn (0.5-0.9). 0 = leave it to the model's own default.
   *  A turn close is a PARAGRAPH BREAK, never a submit. */
  voiceEotThreshold: number
  /** flux `eot_timeout_ms`: how long it waits before calling the turn anyway.
   *  0 = model default. */
  voiceEotTimeoutMs: number
  /** flux `eager_eot_threshold` (0.3-0.9, 0 = off). Fires a SPECULATIVE
   *  EagerEndOfTurn early so a voice agent can start generating, retracted with
   *  TurnResumed if the speaker carries on. Built for agents, not dictation:
   *  here it only makes the on-screen text flicker. Off by default. */
  voiceEagerEotThreshold: number
  /** Strip hesitation noises ("uh", "um", "erm") from a finished dictation before
   *  it is sent. ON by default -- flux hands fillers straight through and nobody
   *  wants to read their own "uh" back. Applied at SUBMIT only, never to the live
   *  transcript, and it never touches repeated words. See lib/voice-defluff.ts. */
  voiceStripFillers: boolean
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
  /** Collapse the conversation's project root to `.` wherever it appears in a
   *  displayed command -- arguments, assignments, redirects, later lines -- and
   *  drop the `cd <project-path> &&` that becomes a no-op. DISPLAY ONLY: the
   *  copy button on a shell command always yields the untouched original. */
  sanitizePaths: boolean
  inputBackend: 'legacy' | 'codemirror' // editor backend for InputEditor (default legacy)
  settingsTab: SettingsTab // last active settings tab (per-device)
  theme: string // UI theme id (see lib/themes.ts)
  /** Sidebar conversation-list rendering. 'default' = full compact rows (today);
   *  'rail' = status-rail: state-colored glyph + project monogram/spine, denser.
   *  Per-device (localStorage). Toggle via the `> List view` palette command. */
  listViewMode: 'default' | 'rail'
  /** Active workspace filter. null = "All" (show every root node). */
  activeWorkspaceId: string | null
  /** PULSE default view. 'bands' groups by activity; 'tide' is one time axis.
   *  Toggled inside the Pulse surface, remembered per-device. */
  pulseView: 'bands' | 'tide'
  /** PULSE strip: the always-on 30px bar pinned under the app. OFF by default —
   *  it permanently spends vertical space, so it is opt-in. */
  pulseStrip: boolean
  /** Virtualizer Lab experiment knobs (Experiments settings tab). Stored as a
   *  partial so knobs added later inherit their defaults; resolve with
   *  resolveVirtualizerLab() at the point of use. {} = production behavior. */
  virtualizerLab: Partial<VirtualizerLabPrefs>
  /** Plain Renderer Lab experiment knobs (Experiments settings tab; only shown
   *  when transcriptRenderer==='plain'). Stored as a partial so knobs added
   *  later inherit their defaults; resolve with resolvePlainRendererLab() at
   *  the point of use. {} = production behavior. Governs scroll-back anchoring
   *  (content-visibility, prepend/above anchors, overflow-anchor). */
  plainRendererLab: Partial<PlainRendererLabPrefs>
  /** Transcript scroll/measure engine. 'plain' (DEFAULT) = the non-virtualized
   *  TranscriptViewPlain (stick-to-bottom engine + browser-native scroll
   *  mechanics: scrollHeight prepend anchor, IntersectionObserver scrollback,
   *  content-visibility offscreen skipping). 'virtualized' = the legacy TanStack
   *  virtualizer (opt-in; the Virtualizer Lab experiments only apply to it).
   *  Per-device. Plan: .claude/docs/plan-transcript-non-virtualized.md. */
  transcriptRenderer: 'plain' | 'virtualized'
}

// 'general' is legacy (tab removed 2026-07; kept so stored prefs still typecheck --
// the dialog falls back to 'display' for unknown ids).
export type SettingsTab =
  | 'general'
  | 'display'
  | 'input'
  | 'voice'
  | 'sessions'
  | 'sentinels'
  | 'system'
  | 'experiments'

const defaultPrefs: ControlPanelPrefs = {
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
  // DIRECT BY DEFAULT (2026-08-13). The relay path measured 8.5-11.8 SECONDS
  // behind real time on 2 of 3 runs from Thailand; the Cloudflare edge was flat
  // on 3 of 3. A fresh browser must not land on the slow path.
  voiceDirectToDeepgram: true,
  voiceSttModel: DEFAULT_STT_MODEL,
  voiceEotThreshold: 0,
  voiceEotTimeoutMs: 0,
  voiceEagerEotThreshold: 0,
  voiceStripFillers: true,
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
  pulseView: 'bands',
  pulseStrip: false,
  virtualizerLab: {},
  plainRendererLab: {},
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
      // Ended conversations are never shown -- these toggles are gone by decree,
      // not defaulted off. Drop the stored keys so nothing can resurrect them.
      delete stored.showEndedConversations
      delete stored.showInactiveByDefault
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
