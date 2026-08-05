/**
 * Canvas chat state: who the canvas is connected to, the running transcript,
 * and sending (with the current selection attached).
 *
 * The transcript is DELIBERATELY not persisted. The chat is a conversation with
 * a surface that is open in front of you -- the agent's replies ride the canvas
 * room and are dropped when nobody is looking, so a "history" that survives a
 * reload would be a half-truth. The real record is the connected conversation's
 * own transcript, which is one click away.
 */

import type { CanvasSummary } from '@shared/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConversations, wsSend } from '@/hooks/use-conversations'
import { registerCanvasChatListener, unregisterCanvasChatListener } from './canvas-chat-bus'
import { type ChatCandidate, liveCandidates } from './canvas-chat-candidates'
import { readCanvasSelection } from './canvas-selection-source'

export interface ChatLine {
  role: 'you' | 'agent'
  /** Who said it -- the agent's conversation name, or 'you'. */
  who: string
  text: string
  /** What rode along as context, for the user's own line only. */
  context?: string
  ts: number
}

export interface CanvasChat {
  /** ONLINE conversations in this canvas's project, ranked live-first. */
  candidates: ChatCandidate[]
  connectedId: string | null
  connectedName: string | null
  lines: ChatLine[]
  /** Set when the last connect/send was refused, so the panel can say why. */
  error: string | null
  connect(conversationId: string | null): void
  send(text: string): void
}

/** An agent reply arriving through the canvas room, or null for other frames. */
function agentLineFrom(msg: Record<string, unknown>): ChatLine | null {
  if (msg.type !== 'canvas_chat_message') return null
  return {
    role: 'agent',
    who: String(msg.sourceName ?? 'agent'),
    text: String(msg.body ?? ''),
    ts: Number(msg.ts) || Date.now(),
  }
}

/** A result for one of OUR verbs: the error to show, and (for connect) the new
 *  connection. `connectedId: undefined` means "leave the connection alone". */
function resultFrom(msg: Record<string, unknown>): { error: string | null; connectedId?: string | null } | null {
  const ok = msg.ok === true
  if (msg.type === 'canvas_chat_connect_result') {
    return {
      error: ok ? null : String(msg.error ?? 'connect failed'),
      connectedId: ok ? ((msg.conversationId as string | null) ?? null) : undefined,
    }
  }
  if (msg.type === 'canvas_chat_send_result') return { error: ok ? null : String(msg.error ?? 'send failed') }
  return null
}

/**
 * The connected conversation, with the SERVER winning.
 *
 * The canvas row is the source of truth (it survives a broker restart), so a
 * fresh summary always overrides local optimism -- but connect/disconnect must
 * still feel instant, hence the local setter too.
 */
function useConnection(canvas: CanvasSummary | null): [string | null, (id: string | null) => void] {
  const fromServer = canvas?.connectedConversationId ?? null
  const [connectedId, setConnectedId] = useState<string | null>(fromServer)
  // react-doctor-disable-next-line react-doctor/no-derived-state -- server state wins over local optimism
  const [prev, setPrev] = useState(fromServer)
  if (fromServer !== prev) {
    setPrev(fromServer)
    setConnectedId(fromServer)
  }
  return [connectedId, setConnectedId]
}

export function useCanvasChat(canvas: CanvasSummary | null): CanvasChat {
  const canvasId = canvas?.id ?? null
  const conversations = useConversations()
  const [connectedId, setConnectedId] = useConnection(canvas)
  const [lines, setLines] = useState<ChatLine[]>([])
  const [error, setError] = useState<string | null>(null)

  /** Local project + online only -- see canvas-chat-candidates for why both. */
  const candidates = useMemo(
    () => (canvas ? liveCandidates(conversations, canvas.projectUri) : []),
    [conversations, canvas],
  )

  /** Resolved off the FULL list, not the candidates: a connection outlives the
   *  conversation going offline, and the header should still name it. */
  const connectedName = useMemo(() => {
    if (!connectedId) return null
    return conversations.find(c => c.id === connectedId)?.title || connectedId.slice(0, 8)
  }, [conversations, connectedId])

  useEffect(() => {
    if (!canvasId) return
    registerCanvasChatListener(canvasId, msg => {
      const line = agentLineFrom(msg)
      if (line) {
        setLines(prev => [...prev, line])
        return
      }
      const outcome = resultFrom(msg)
      if (!outcome) return
      setError(outcome.error)
      if (outcome.connectedId !== undefined) setConnectedId(outcome.connectedId)
    })
    return () => unregisterCanvasChatListener(canvasId)
  }, [canvasId])

  const connect = useCallback(
    (conversationId: string | null) => {
      if (!canvasId) return
      setError(null)
      wsSend('canvas_chat_connect', { canvasId, conversationId })
    },
    [canvasId],
  )

  const send = useCallback(
    (text: string) => {
      const body = text.trim()
      if (!canvasId || !body) return
      const selection = readCanvasSelection(canvasId)
      setError(null)
      // Echo locally: the broker relays the AGENT's replies into the room, not
      // our own line, so the panel owns showing what we just said.
      setLines(prev => [
        ...prev,
        {
          role: 'you',
          who: 'you',
          text: body,
          context: selection.count > 0 ? `${selection.count} selected` : undefined,
          ts: Date.now(),
        },
      ])
      wsSend('canvas_chat_send', { canvasId, message: body, selection })
    },
    [canvasId],
  )

  return { candidates, connectedId, connectedName, lines, error, connect, send }
}
