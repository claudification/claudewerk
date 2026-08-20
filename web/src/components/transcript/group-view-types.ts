import type { TranscriptContentBlock, TranscriptImage, TranscriptToolUseResult } from '@/lib/types'
import type { SelectedChip } from './canvas-selected-parse'

export const BUBBLE_COLORS: Record<string, string> = {
  blue: 'bg-primary/90',
  teal: 'bg-teal-600/90',
  purple: 'bg-purple-600/90',
  green: 'bg-emerald-600/90',
  orange: 'bg-amber-600/90',
  pink: 'bg-pink-600/90',
  indigo: 'bg-indigo-600/90',
}

export const BUBBLE_COLOR_OPTIONS = Object.keys(BUBBLE_COLORS)

export interface RenderableTranscriptEntry {
  message?: { role?: string; content?: string | TranscriptContentBlock[] }
  images?: TranscriptImage[]
  toolUseResult?: TranscriptToolUseResult
}

export interface TranscriptSettings {
  expandAll: boolean
  userLabel: string
  agentLabel: string
  userColor: string
  agentColor: string
  userSize: string
  agentSize: string
  chatBubbles: boolean
  bubbleColor: string
}

export type ResultLookup = (
  id: string,
) => { result: string; extra?: Record<string, unknown>; isError?: boolean } | undefined

export type RenderItem =
  /** `voice` = the user DICTATED this. Set by parseGroupEntries when it strips the
   *  agent host's reading hint back off (shared/voice-hint.ts); the bubble renders
   *  italic behind a mic glyph so speech never reads as a written spec. */
  | { kind: 'text'; text: string; voice?: boolean }
  | { kind: 'thinking'; text: string; encryptedBytes?: number; rawBlock?: TranscriptContentBlock }
  | {
      kind: 'project-task'
      id: string
      title: string
      body: string
      priority?: string
      taskStatus?: string
      tags?: string[]
    }
  | {
      kind: 'tool'
      tool: TranscriptContentBlock
      result?: string
      extra?: Record<string, unknown>
      isError?: boolean
    }
  | { kind: 'bash'; text: string }
  | {
      kind: 'channel'
      text: string
      source: string
      conversationId?: string
      intent?: string
      isInterConversation?: boolean
      /** The voice orb relayed this (renders violet "from Orb", not a peer). */
      isOrbChannel?: boolean
      /** Sent from a canvas chat window: `canvasId` links back to it and the
       *  selection renders as chips instead of raw `<selected>` markup. */
      isCanvasChannel?: boolean
      canvasId?: string | null
      canvasChips?: SelectedChip[]
      canvasCensus?: { count: number; summary: string }
      isDialog?: boolean
      /** A live (persistent) dialog the user just submitted -- rendered rich, not raw. */
      isDialogSubmit?: boolean
      dialogStatus?: string
      dialogAction?: string
      dialogId?: string
      isSystem?: boolean
      systemKind?: string
      recapId?: string
    }
  | { kind: 'images'; images: Array<{ hash: string; ext: string; url: string; originalPath: string }> }
  // Inline system entry rendered inside an assistant group (api_retry,
  // informational, turn_duration, etc.). Carries the raw entry so the
  // renderer can dispatch on subtype just like the standalone SystemLine.
  | { kind: 'system'; entry: Record<string, unknown>; subtype: string; timestamp?: string }

// Byte-identical to `formatDuration` in `src/acp-agent-host/translator.ts` and
// `src/opencode-agent-host/ndjson-parser.ts` (fallow clone group `dup:36aa297d`).
// Deliberately NOT suppressed -- consolidating it crosses the src/web boundary
// and is tracked by `repo-format-duration-clone-group`.
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s % 60)}s`
}
