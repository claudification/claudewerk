#!/usr/bin/env bun
/**
 * VERIFICATION smoke for the canvas AGENT-WRITE path (`bun run canvas:smoke`).
 *
 * The board card `canvas-conversation-chat` declares one load-bearing
 * assumption: "the agent can create/edit things on the canvas" -- i.e. the
 * canvas MCP tools (canvas_create / canvas_read / canvas_update_scene) work
 * end-to-end WHILE a human has the canvas open. This script proves or disproves
 * exactly that against a REAL broker process (throwaway cache dir + port, never
 * the prod broker).
 *
 * The MCP tools are thin HTTP clients (src/agent-host-common/mcp-host/
 * mcp-tools/canvas.ts), so driving the same routes with the same bodies IS the
 * tool path -- minus the MCP envelope.
 *
 * Four checks, in the order the feature needs them:
 *   A  create + read round-trip            (does an agent-authored scene persist?)
 *   B  update_scene round-trip             (does an agent EDIT persist?)
 *   C  live push: does a joined canvas room peer SEE the agent's write?
 *   D  clobber: does the agent's write survive the human's next edit?
 *
 * C and D are the ones that matter for the chat feature -- a user watching the
 * canvas while the agent draws on it. Failures print WHAT broke and WHERE.
 */
import { join } from 'node:path'
import { createSmokeReport, mintDevKey, openSmokeSocket, type SmokeSocket, startSmokeBroker } from './lib/smoke-broker'

const PORT = Number(process.env.CANVAS_SMOKE_PORT) || 9348
const BASE = `http://localhost:${PORT}`
const SECRET = 'canvas-smoke-secret'
const PROJECT = 'claude://canvas-smoke/tmp/canvas-smoke'
const REPO = join(import.meta.dir, '..')

const auth = { Authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }

/** An Excalidraw scene with one rectangle carrying `tag` in its id. */
function scene(tag: string, extra: Record<string, unknown>[] = []): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [
      {
        id: tag,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 60,
        version: 1,
        versionNonce: 1,
        seed: 1,
        isDeleted: false,
      },
      ...extra,
    ],
    appState: {},
  })
}

function elementIds(sceneJson: string | null): string[] {
  if (!sceneJson) return []
  try {
    const parsed = JSON.parse(sceneJson) as { elements?: { id: string; isDeleted?: boolean }[] }
    return (parsed.elements ?? []).filter(e => !e.isDeleted).map(e => e.id)
  } catch {
    return []
  }
}

/**
 * A joined canvas-room peer, modelling what the BROWSER actually does: collect
 * inbound frames AND apply scene deltas to a local scene (use-canvas-collab.ts
 * pushes them into the Excalidraw API). That local copy is what its next edit
 * is built on -- which is exactly the property check D is about, so a peer that
 * ignored deltas would be testing a merge guarantee the design never made.
 */
interface RoomPeer extends SmokeSocket {
  /** Newest scene this peer has applied, seeded from canvas_join_ack. */
  localScene(): string | null
}

/** Frame types that carry a full scene the client adopts wholesale: the join
 *  ack seeds it, every later delta replaces it (replace-on-delta, no merge). */
const SCENE_BEARING = new Set(['canvas_join_ack', 'canvas_scene_delta'])

/** Fold a frame log into the scene a client would currently be showing. */
function foldScene(frames: Record<string, unknown>[]): string | null {
  let scene: string | null = null
  for (const f of frames) {
    if (SCENE_BEARING.has(String(f.type)) && typeof f.scene === 'string') scene = f.scene
  }
  return scene
}

async function joinRoom(canvasId: string, cookie: string): Promise<RoomPeer> {
  const sock = await openSmokeSocket(`ws://localhost:${PORT}/ws`, { Cookie: `cw-session=${cookie}` })
  sock.send({ type: 'canvas_join', canvasId, name: 'smoke-human' })
  const acked = await sock.until(f => f.some(x => x.type === 'canvas_join_ack' || x.type === 'canvas_error'))
  const refusal = sock.frames.find(f => f.type === 'canvas_error')
  if (refusal) throw new Error(`canvas_join refused: ${JSON.stringify(refusal)}`)
  if (!acked) throw new Error('never got canvas_join_ack')
  return { ...sock, localScene: () => foldScene(sock.frames) }
}

const { check, finish } = createSmokeReport()

/** The MCP `canvas_read` path: stored element ids for a canvas. */
async function storedIds(id: string): Promise<string[]> {
  const res = (await (await fetch(`${BASE}/api/canvases/${id}`, { headers: auth })).json()) as { scene: string | null }
  return elementIds(res.scene)
}

/** The MCP `canvas_update_scene` path. */
function agentWrite(id: string, sceneJson: string): Promise<Response> {
  return fetch(`${BASE}/api/canvases/${id}/scene`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ scene: sceneJson }),
  })
}

/** A: the MCP `canvas_create` path, seeded with a scene. Returns the new id. */
async function checkCreate(): Promise<string> {
  const res = await fetch(`${BASE}/api/canvases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ projectUri: PROJECT, name: 'smoke canvas', scene: scene('agent-seed') }),
  })
  if (!res.ok) throw new Error(`create failed ${res.status}: ${await res.text()}`)
  const { canvas } = (await res.json()) as { canvas: { id: string } }
  const ids = await storedIds(canvas.id)
  check(
    'A. canvas_create seeds a scene that canvas_read returns',
    ids.includes('agent-seed'),
    `read back element ids: [${ids.join(', ')}]`,
  )
  return canvas.id
}

/** B: an agent edit to a canvas nobody has open. */
async function checkEdit(id: string): Promise<void> {
  const put = await agentWrite(id, scene('agent-edit-1'))
  const ids = await storedIds(id)
  check(
    'B. canvas_update_scene persists the agent edit',
    put.ok && ids.includes('agent-edit-1'),
    `PUT ${put.status}; stored element ids: [${ids.join(', ')}]`,
  )
}

/** C: a HUMAN has the canvas open -- does the agent's write reach them? */
async function checkLivePush(id: string, human: RoomPeer): Promise<void> {
  await agentWrite(id, scene('agent-edit-live'))
  await Bun.sleep(1200)
  const deltas = human.of('canvas_scene_delta')
  check(
    'C. an open canvas room SEES the agent write (live push)',
    deltas.length > 0,
    deltas.length > 0
      ? `${deltas.length} canvas_scene_delta frame(s) reached the open canvas`
      : 'NO canvas_scene_delta reached the open canvas -- the HTTP scene write never enters the room',
  )
}

/**
 * D: the human draws AFTER the agent wrote.
 *
 * This is the end-to-end consequence of C, and the check that actually caught
 * the data loss. Scene sync is last-writer-wins replace-on-delta -- the broker
 * does NOT merge -- so the agent's work survives for exactly one reason: the
 * human's editor received the agent's delta and built its next edit on top. If
 * the broadcast regresses, this peer's local scene goes stale and its next
 * write silently deletes the agent's elements, which is the original bug.
 */
async function checkClobber(id: string, human: RoomPeer): Promise<void> {
  const humanElement = {
    id: 'human-edit',
    type: 'ellipse',
    x: 200,
    y: 0,
    width: 50,
    height: 50,
    version: 1,
    versionNonce: 2,
    seed: 2,
    isDeleted: false,
  }
  // The human draws on top of WHAT THEY CURRENTLY SEE, exactly like the browser.
  const current = human.localScene()
  const parsed = JSON.parse(current ?? scene('empty')) as { elements: Record<string, unknown>[] }
  parsed.elements = [...parsed.elements, humanElement]
  human.ws.send(JSON.stringify({ type: 'canvas_scene_delta', canvasId: id, scene: JSON.stringify(parsed) }))

  await Bun.sleep(2500) // past the 1.5s room persist debounce
  const ids = await storedIds(id)
  const survived = ids.includes('agent-edit-live') && ids.includes('human-edit')
  check(
    "D. the agent's write survives the human's next edit",
    survived,
    `stored element ids after the human's edit: [${ids.join(', ')}]` +
      (survived ? '' : " -- expected BOTH 'agent-edit-live' and 'human-edit'; the agent element was OVERWRITTEN"),
  )
}

async function run(cookie: string): Promise<void> {
  const id = await checkCreate()
  await checkEdit(id)
  const human = await joinRoom(id, cookie)
  try {
    await checkLivePush(id, human)
    await checkClobber(id, human)
  } finally {
    human.close()
  }
}

const broker = await startSmokeBroker({
  port: PORT,
  secret: SECRET,
  repo: REPO,
  label: 'canvas-smoke',
  logs: !!process.env.CANVAS_SMOKE_LOGS,
})
try {
  await run(mintDevKey(REPO, broker.cacheDir))
} finally {
  broker.stop()
}

finish()
