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
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

function bootBroker(cacheDir: string) {
  return spawn(
    'bun',
    ['run', 'src/broker/index.ts', '--cache-dir', cacheDir, '--port', String(PORT), '--rclaude-secret', SECRET],
    {
      cwd: REPO,
      env: { ...process.env, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', DEV_HARNESS_ENABLED: '1' },
      stdio: 'ignore',
    },
  )
}

async function waitHealth(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return
    } catch {}
    await Bun.sleep(500)
  }
  throw new Error(`broker did not become healthy on ${BASE}`)
}

function mintDevKey(cacheDir: string): string {
  const r = Bun.spawnSync(
    ['bun', 'run', 'src/broker/cli.ts', 'mint-dev-key', '--as', 'smoke-user', '--cache-dir', cacheDir],
    { cwd: REPO, env: { ...process.env, DEV_HARNESS_ENABLED: '1' } },
  )
  const out = r.stdout.toString() + r.stderr.toString()
  const token = out.match(/dvk_[A-Za-z0-9_\-.]+/)?.[0]
  if (!token) throw new Error(`could not mint a dev key:\n${out}`)
  return token
}

/**
 * A joined canvas-room peer, modelling what the BROWSER actually does: collect
 * inbound frames AND apply scene deltas to a local scene (use-canvas-collab.ts
 * pushes them into the Excalidraw API). That local copy is what its next edit
 * is built on -- which is exactly the property check D is about, so a peer that
 * ignored deltas would be testing a merge guarantee the design never made.
 */
interface RoomPeer {
  ws: WebSocket
  frames: Record<string, unknown>[]
  of(type: string): Record<string, unknown>[]
  /** Newest scene this peer has applied, seeded from canvas_join_ack. */
  localScene(): string | null
  close(): void
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

/** Open an authenticated dashboard socket and start collecting frames. */
async function openSocket(cookie: string): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: `cw-session=${cookie}` } } as never)
  const frames: Record<string, unknown>[] = []
  ws.addEventListener('message', ev => {
    try {
      frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>)
    } catch {}
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('WS connect failed')))
    setTimeout(() => reject(new Error('WS connect timed out')), 5000)
  })
  return { ws, frames }
}

/** Wait for the join to be acked, surfacing a refusal as a thrown error. */
async function awaitJoinAck(frames: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (frames.some(f => f.type === 'canvas_join_ack')) return
    const refusal = frames.find(f => f.type === 'canvas_error')
    if (refusal) throw new Error(`canvas_join refused: ${JSON.stringify(refusal)}`)
    await Bun.sleep(100)
  }
  throw new Error('never got canvas_join_ack')
}

async function joinRoom(canvasId: string, cookie: string): Promise<RoomPeer> {
  const { ws, frames } = await openSocket(cookie)
  ws.send(JSON.stringify({ type: 'canvas_join', canvasId, name: 'smoke-human' }))
  await awaitJoinAck(frames)
  return {
    ws,
    frames,
    of: type => frames.filter(f => f.type === type),
    localScene: () => foldScene(frames),
    close: () => ws.close(),
  }
}

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

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

const cacheDir = mkdtempSync(join(tmpdir(), 'canvas-smoke-'))
const broker = bootBroker(cacheDir)
try {
  await waitHealth()
  const cookie = mintDevKey(cacheDir)
  await run(cookie)
} finally {
  broker.kill()
  rmSync(cacheDir, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
process.exit(failed.length ? 1 : 0)
