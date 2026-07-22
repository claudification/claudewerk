/**
 * Canvas SQLite row shape + mapping to the wire-facing CanvasSummary.
 * Split out of canvas-store.ts to keep the store module focused on DB ops.
 */

import type { CanvasShareTier, CanvasSummary } from '../shared/protocol'

/** Raw SQLite row (snake_case columns). */
export interface CanvasRow {
  id: string
  project_uri: string
  name: string
  created_by: string | null
  created_at: number
  updated_at: number
  scene_bytes: number
  has_thumb: number
  shared: number
  share_token: string | null
  share_tier: CanvasShareTier | null
  /** Epoch ms the share link dies; null = no expiry (share until revoked). */
  share_expires_at: number | null
  /** Conversation this canvas's chat window is wired to; null = not connected. */
  connected_conversation_id: string | null
  archived_at: number | null
}

/** Columns selected for every read, in row order. */
export const CANVAS_COLS =
  'id, project_uri, name, created_by, created_at, updated_at, scene_bytes, has_thumb, shared, share_token, share_tier, share_expires_at, connected_conversation_id, archived_at'

export function rowToSummary(r: CanvasRow): CanvasSummary {
  return {
    id: r.id,
    projectUri: r.project_uri,
    name: r.name,
    createdBy: r.created_by ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    shared: r.shared === 1,
    shareTier: r.share_tier ?? undefined,
    shareToken: r.share_token ?? undefined,
    shareExpiresAt: r.share_expires_at ?? undefined,
    connectedConversationId: r.connected_conversation_id ?? undefined,
    hasThumb: r.has_thumb === 1,
    sceneBytes: r.scene_bytes,
    archivedAt: r.archived_at,
  }
}
