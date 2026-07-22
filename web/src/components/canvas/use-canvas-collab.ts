/**
 * Canvas live-multiplayer client. Joins the broker `canvas` room for a canvasId,
 * applies inbound cursors + scene deltas to the Excalidraw API, and exposes
 * local pointer/change senders. Echo-safe: a short suppression window after a
 * remote scene apply stops our own onChange from rebroadcasting it, and we
 * ignore deltas/cursors stamped with our own peerId.
 */

import type { CanvasPeer } from '@shared/protocol'
import { useCallback, useMemo, useRef, useState } from 'react'
import { wsSend } from '@/hooks/use-conversations'
import { parseSceneElements, peerToApply, prunePeers, type RemoteCollaborator } from './canvas-collab-merge'
import { clearCanvasPeerId, setCanvasPeerId } from './canvas-peer-id'
import { useCanvasRoom } from './use-canvas-room'

/** Minimal slice of the Excalidraw imperative API the collab layer drives. */
export interface CollabApi {
  updateScene(scene: { elements?: readonly unknown[]; collaborators?: Map<string, unknown> }): void
}

/** A remote apply within this window suppresses the resulting local onChange. */
const ECHO_SUPPRESS_MS = 300

export interface CanvasCollab {
  peers: CanvasPeer[]
  bindApi: (api: CollabApi | null) => void
  onLocalPointer: (x: number, y: number, tool?: 'pointer' | 'laser', button?: 'up' | 'down') => void
  onLocalChange: (sceneJson: string) => void
}

// Cognitive score here is driven by hook COUNT (many trivial memoized inbound
// updaters), not branching: cyclomatic is 2, maintainability 86.7. The room
// lifecycle is already split out (use-canvas-room); fragmenting the cohesive
// cursor/scene apply callbacks further to satisfy the per-hook penalty would hurt
// readability, not help it.
// fallow-ignore-next-line complexity
export function useCanvasCollab(canvasId: string | null, enabled: boolean, name?: string): CanvasCollab {
  const [peers, setPeers] = useState<CanvasPeer[]>([])
  const api = useRef<CollabApi | null>(null)
  const ownPeerId = useRef<string | null>(null)
  const collaborators = useRef<Map<string, RemoteCollaborator>>(null!)
  if (collaborators.current === null) collaborators.current = new Map()
  const suppressUntil = useRef(0)

  const pushCollaborators = useCallback(() => {
    api.current?.updateScene({ collaborators: new Map(collaborators.current) })
  }, [])

  // Inbound handlers split out so the listener stays a thin dispatch (each
  // case body is its own low-complexity unit).
  const applyPresence = useCallback(
    (msg: Record<string, unknown>) => {
      const roster = (msg.peers as CanvasPeer[]) ?? []
      setPeers(roster)
      prunePeers(collaborators.current, roster)
      pushCollaborators()
    },
    [pushCollaborators],
  )

  const applyPointer = useCallback(
    (msg: Record<string, unknown>) => {
      const entry = peerToApply(msg, ownPeerId.current)
      if (!entry) return
      collaborators.current.set(entry.id, entry.collaborator)
      pushCollaborators()
    },
    [pushCollaborators],
  )

  const applySceneDelta = useCallback((msg: Record<string, unknown>) => {
    if ((msg.peerId as string) === ownPeerId.current) return
    const elements = parseSceneElements(msg.scene)
    if (!elements) return // malformed -- keep current scene
    suppressUntil.current = Date.now() + ECHO_SUPPRESS_MS
    api.current?.updateScene({ elements })
  }, [])

  const applyJoinAck = useCallback(
    (msg: Record<string, unknown>) => {
      const peerId = msg.peerId as string
      ownPeerId.current = peerId
      // Publish it for the autosave PUT, which must name this peer or the broker
      // broadcasts our own save back to us as an agent write (see canvas-peer-id).
      if (canvasId && peerId) setCanvasPeerId(canvasId, peerId)
    },
    [canvasId],
  )

  // Inbound canvas_* -> handler map (stable; the room hook depends on its identity).
  const handlers = useMemo(
    () => ({
      canvas_join_ack: applyJoinAck,
      canvas_presence: applyPresence,
      canvas_pointer: applyPointer,
      canvas_scene_delta: applySceneDelta,
    }),
    [applyJoinAck, applyPresence, applyPointer, applySceneDelta],
  )

  const resetRoom = useCallback(() => {
    collaborators.current.clear()
    ownPeerId.current = null
    if (canvasId) clearCanvasPeerId(canvasId)
    setPeers([])
  }, [canvasId])

  // Join/leave lifecycle (waits for a live socket, re-joins on reconnect). See
  // use-canvas-room.ts -- the socket-open gating THERE is the multiplayer fix.
  useCanvasRoom(canvasId, enabled, name, handlers, resetRoom)

  const bindApi = useCallback((next: CollabApi | null) => {
    api.current = next
  }, [])

  const onLocalPointer = useCallback(
    (x: number, y: number, tool?: 'pointer' | 'laser', button?: 'up' | 'down') => {
      if (canvasId) wsSend('canvas_pointer', { canvasId, x, y, tool, button })
    },
    [canvasId],
  )

  const onLocalChange = useCallback(
    (sceneJson: string) => {
      if (!canvasId) return
      if (Date.now() < suppressUntil.current) return // echo of a remote apply
      wsSend('canvas_scene_delta', { canvasId, scene: sceneJson })
    },
    [canvasId],
  )

  return { peers, bindApi, onLocalPointer, onLocalChange }
}
