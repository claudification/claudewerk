#!/usr/bin/env bun
/**
 * End-to-end smoke for the CANVAS CHAT loop (`bun run canvas:chat:smoke`).
 *
 * Proves the full round trip against a REAL broker (throwaway cache dir + port,
 * never the prod broker), with no browser:
 *
 *   1. connect   -- the owner wires a canvas to a conversation
 *   2. send      -- a typed line + selection reaches that conversation as a
 *                   channel_deliver addressed FROM canvas:<id>
 *   3. reply     -- the conversation answers canvas:<id> and it lands in the
 *                   canvas ROOM, where every viewer sees it
 *   4. refuse    -- a conversation that is NOT connected cannot speak into the
 *                   canvas even though it knows the id
 *   5. revoke    -- disconnecting kills the reply path immediately
 *
 * Legs 4 and 5 are the ones worth having: canvas ids are not secret, so the
 * whole security story is "only the connected conversation may talk". They are
 * also the ones that lie most easily -- while leg 3 was broken they passed
 * vacuously, because nothing reached the room either way. If you touch this
 * file, re-check them by breaking canConversationReachCanvas on purpose.
 *
 * The "conversation" here is a raw WS speaking the agent-host role, which is
 * exactly what a real agent host is on this seam -- it receives channel_deliver
 * and sends channel_send.
 *
 * CANVAS_CHAT_SMOKE_LOGS=1 surfaces the broker's log ([canvas-sink] /
 * [canvas-chat] lines), which is how you diagnose a failing leg.
 */
import { join } from 'node:path'
import { AGENT_HOST_PROTOCOL_VERSION } from '../src/shared/protocol'
import { createSmokeReport, mintDevKey, openSmokeSocket, type SmokeSocket, startSmokeBroker } from './lib/smoke-broker'

const PORT = Number(process.env.CANVAS_CHAT_SMOKE_PORT) || 9351
const SECRET = 'canvas-chat-smoke-secret'
const PROJECT = 'claude://canvas-chat-smoke/tmp/canvas-chat-smoke'
const REPO = join(import.meta.dir, '..')
const CONV = 'conv-smoke-agent'

const { check, finish } = createSmokeReport()

/** A conversation, as the broker sees one: an agent-host socket that has
 *  registered itself and can send/receive channel traffic. */
async function openConversation(conversationId: string): Promise<SmokeSocket> {
  const sock = await openSmokeSocket(`ws://localhost:${PORT}/ws?secret=${encodeURIComponent(SECRET)}`)
  const boot = { conversationId, project: PROJECT, protocolVersion: AGENT_HOST_PROTOCOL_VERSION }
  sock.send({ type: 'agent_host_boot', ...boot, capabilities: [] })
  sock.send({ type: 'meta', ...boot, title: 'smoke-agent' })
  await Bun.sleep(400)
  return sock
}

/** Ask the broker to relay a line from `conversationId` into a canvas. */
function replyToCanvas(sock: SmokeSocket, conversationId: string, canvasId: string, message: string): void {
  // NOTE: the wire field is `toConversation`, not `to` -- channel_send returns
  // early without it, which is exactly how leg 3 failed the first time.
  sock.send({ type: 'channel_send', conversationId, toConversation: `canvas:${canvasId}`, message, intent: 'response' })
}

async function checkConnect(panel: SmokeSocket, canvasId: string): Promise<void> {
  panel.send({ type: 'canvas_chat_connect', canvasId, conversationId: CONV })
  await panel.until(f => f.some(x => x.type === 'canvas_chat_connect_result'))
  const res = panel.of('canvas_chat_connect_result')[0]
  check(
    '1. the owner can connect a canvas to a conversation',
    res?.ok === true,
    `result: ${JSON.stringify(res ?? null)}`,
  )
}

// The cyclomatic count here IS the assertion: one && chain pinning every field
// of the delivery. A smoke script has no unit tests by definition, so CRAP is
// zero-coverage arithmetic, not risk.
// fallow-ignore-next-line complexity
async function checkSend(panel: SmokeSocket, agent: SmokeSocket, canvasId: string): Promise<void> {
  const selection = {
    count: 2,
    elements: [
      { id: 'el-a', type: 'rectangle', strokeColor: '#1971c2' },
      { id: 'el-b', type: 'ellipse' },
    ],
    truncated: false,
  }
  panel.send({ type: 'canvas_chat_send', canvasId, message: 'make these blue', selection })
  const got = await agent.until(f => f.some(x => x.type === 'channel_deliver'))
  const d = agent.of('channel_deliver')[0]
  const ids = (d?.selection as { elements?: { id: string }[] } | undefined)?.elements?.map(e => e.id).join(',')
  check(
    '2. the typed line + selection reach the conversation, addressed FROM the canvas',
    got &&
      d?.fromConversation === `canvas:${canvasId}` &&
      d?.canvasId === canvasId &&
      d?.source === 'rclaude' &&
      ids === 'el-a,el-b',
    got
      ? `from=${d?.fromConversation} canvas_id=${d?.canvasId} source=${d?.source} selection=[${ids ?? ''}]`
      : 'the conversation received NO channel_deliver',
  )
}

// fallow-ignore-next-line complexity -- same: assertion arity on an untested-by-design script.
async function checkReply(panel: SmokeSocket, agent: SmokeSocket, canvasId: string): Promise<void> {
  replyToCanvas(agent, CONV, canvasId, 'done -- both are blue now')
  const got = await panel.until(f => f.some(x => x.type === 'canvas_chat_message'))
  const chat = panel.of('canvas_chat_message')[0]
  check(
    '3. the reply lands in the canvas room for everyone watching',
    got && chat?.body === 'done -- both are blue now' && chat?.canvasId === canvasId,
    got ? `"${chat?.body}" from "${chat?.sourceName}" (role=${chat?.role})` : 'no canvas_chat_message reached the room',
  )
}

async function checkStrangerRefused(panel: SmokeSocket, canvasId: string): Promise<SmokeSocket> {
  const stranger = await openConversation('conv-smoke-stranger')
  panel.clear()
  replyToCanvas(stranger, 'conv-smoke-stranger', canvasId, 'I should not be here')
  const leaked = await panel.until(f => f.some(x => x.type === 'canvas_chat_message'), 1500)
  check(
    '4. an unconnected conversation cannot speak into the canvas',
    !leaked,
    leaked ? 'LEAK: a conversation that was never connected reached the chat' : 'refused -- nothing reached the room',
  )
  return stranger
}

async function checkRevoke(panel: SmokeSocket, agent: SmokeSocket, canvasId: string): Promise<void> {
  panel.send({ type: 'canvas_chat_connect', canvasId, conversationId: null })
  await panel.until(f => f.some(x => x.type === 'canvas_chat_connect_result'))
  panel.clear()
  replyToCanvas(agent, CONV, canvasId, 'still here?')
  const leaked = await panel.until(f => f.some(x => x.type === 'canvas_chat_message'), 1500)
  check(
    '5. disconnecting revokes the reply path immediately',
    !leaked,
    leaked ? 'LEAK: the previously-connected conversation still reached the canvas' : 'refused after disconnect',
  )
}

const broker = await startSmokeBroker({
  port: PORT,
  secret: SECRET,
  repo: REPO,
  label: 'canvas-chat-smoke',
  logs: !!process.env.CANVAS_CHAT_SMOKE_LOGS,
})

try {
  const cookie = mintDevKey(REPO, broker.cacheDir)
  const created = await fetch(`${broker.base}/api/canvases`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectUri: PROJECT, name: 'chat canvas' }),
  })
  const { canvas } = (await created.json()) as { canvas: { id: string } }

  const agent = await openConversation(CONV)
  const panel = await openSmokeSocket(`ws://localhost:${PORT}/ws`, { Cookie: `cw-session=${cookie}` })
  panel.send({ type: 'canvas_join', canvasId: canvas.id, name: 'smoke-human' })
  await panel.until(f => f.some(x => x.type === 'canvas_join_ack'))

  await checkConnect(panel, canvas.id)
  await checkSend(panel, agent, canvas.id)
  await checkReply(panel, agent, canvas.id)
  const stranger = await checkStrangerRefused(panel, canvas.id)
  await checkRevoke(panel, agent, canvas.id)

  agent.close()
  stranger.close()
  panel.close()
} finally {
  broker.stop()
}

finish()
