/**
 * Resolve a canvas scene-delta payload to the elements to apply.
 *
 * A delta carries EITHER a raw Excalidraw scene (elements inline, what a browser
 * peer broadcasts) OR an agent-authored draw-dsl scene (what canvas_update_scene
 * stores and the broker republishes). The DSL one has to be expanded client-side
 * -- exactly what the open path does when seeding (use-dsl-seed) -- or the agent's
 * redraw never reaches anyone who already has the canvas open.
 *
 * null = unusable, keep the current scene. Never wipe on a payload we can't read.
 */

import { parseDslScene, parseSceneElements } from './canvas-collab-merge'

export async function deltaElements(sceneJson: unknown): Promise<readonly unknown[] | null> {
  const raw = parseSceneElements(sceneJson)
  if (raw) return raw
  const dsl = parseDslScene(sceneJson)
  if (!dsl) return null
  // Dynamic: the expander drags the excalidraw skeleton converter (+ a lazy
  // mermaid runtime) with it, and only an agent redraw ever needs it.
  const { dslToElements } = await import('@/components/dialog/excalidraw-dsl-bind')
  return await dslToElements(dsl)
}
