/**
 * Canvas live-multiplayer client. Joins the broker `canvas` room for a canvasId,
 * applies inbound cursors + scene deltas to the Excalidraw API, and exposes
 * local pointer/change senders. Echo-safe: a short suppression window after a
 * remote scene apply stops our own onChange from rebroadcasting it, and we
 * ignore deltas/cursors stamped with our own peerId.
 */

import type { CanvasPeer } from '@shared/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { wsSend } from '@/hooks/use-conversations'
import { registerCanvasListener, unregisterCanvasListener } from './canvas-collab-bus'
import { parseSceneElements, peerToApply, prunePeers, type RemoteCollaborator } from './canvas-collab-merge'

/** Minimal slice of the Excalidraw imperative API the collab layer drives. */
export interface CollabApi {
  updateScene(scene: { elements?: readonly unknown[]; collaborators?: Map<string, unknown> }): void
}

/** A remote apply within this window suppresses the resulting local onChange. */
const ECHO_SUPPRESS_MS = 300

export interface CanvasCollab {
  peers: CanvasPeer[]
  bindApi: (api: CollabApi | null) => void
  onLocalPointer: (x: number, y: number) => void
  onLocalChange: (sceneJson: string) => void
}

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

  useEffect(() => {
    if (!enabled || !canvasId) return

    const byType: Record<string, (m: Record<string, unknown>) => void> = {
      canvas_join_ack: m => {
        ownPeerId.current = m.peerId as string
      },
      canvas_presence: applyPresence,
      canvas_pointer: applyPointer,
      canvas_scene_delta: applySceneDelta,
    }
    registerCanvasListener(canvasId, msg => byType[msg.type as string]?.(msg))
    wsSend('canvas_join', { canvasId, name })

    return () => {
      wsSend('canvas_leave', { canvasId })
      unregisterCanvasListener(canvasId)
      collaborators.current.clear()
      ownPeerId.current = null
      setPeers([])
    }
  }, [canvasId, enabled, name, applyPresence, applyPointer, applySceneDelta])

  const bindApi = useCallback((next: CollabApi | null) => {
    api.current = next
  }, [])

  const onLocalPointer = useCallback(
    (x: number, y: number) => {
      if (canvasId) wsSend('canvas_pointer', { canvasId, x, y })
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
