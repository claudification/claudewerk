/**
 * stt-proxy - the speech-to-text edge for the control panel.
 *
 * WHY IT EXISTS. Voice dictation used to stream from the browser straight to
 * api.deepgram.com, which is a SINGLE US datacenter (api-alt.md1) with no
 * anycast: 270ms RTT from Thailand, and on two of three measured runs the
 * decoder fell 8.5-11.8 SECONDS behind real time. The same Deepgram models
 * hosted on Workers AI held flat at 91-308ms. The model was never the problem;
 * the Pacific was.
 *
 * The browser cannot talk to Workers AI directly -- it authenticates with an
 * `Authorization: Bearer` header, and a browser cannot set headers on a
 * WebSocket. So this Worker sits in the middle, and being forced into it buys
 * three things the old path could not have:
 *
 *   1. NO VENDOR ROUND TRIP TO GET A CREDENTIAL. The old flow minted a Deepgram
 *      token via api.deepgram.com/v1/auth/grant, measured at 838-2718ms in
 *      production, in front of the user's key press. Now the broker signs an
 *      HMAC locally and this Worker verifies it. No egress, no vendor.
 *   2. IT RUNS WHERE THE USER IS. Cloudflare terminates in Bangkok (colo=BKK,
 *      46ms) rather than at the control plane on the other side of an ocean.
 *   3. ONE TRANSCRIPT SHAPE. flux and nova-3 are different API generations;
 *      normalising here is what lets the model be a user-facing setting instead
 *      of a client-side branch.
 *
 * The account token stays server-side. The browser only ever holds a
 * short-lived, single-purpose STT token.
 */

import { verifySttToken } from '../../../src/shared/stt-token'
import { resolveModel, upstreamInputs } from './models'
import { pipeSession } from './session'
import { acceptBinary, dialUpstream, type Env, UpstreamError } from './upstream'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response('ok\n')
    if (url.pathname !== '/listen') return new Response('not found\n', { status: 404 })
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade\n', { status: 426 })
    }
    return handleListen(url, env)
  },
}

// Zero-coverage CRAP estimate. Each branch is a distinct REJECTION the caller must
// tell apart (bad token vs dial failure); merging them would trade a real
// diagnosis for a metric.
// fallow-ignore-next-line complexity
async function handleListen(url: URL, env: Env): Promise<Response> {
  // The token rides the QUERY STRING because a browser cannot set a header on a
  // WebSocket -- the same constraint that makes this Worker necessary. It is
  // short-lived and grants nothing but a speech socket.
  const token = url.searchParams.get('t') ?? ''
  const claims = await verifySttToken(token, env.STT_SIGNING_SECRET)
  if (!claims) {
    // Logged with a reason server-side; the client is told only "no".
    console.log(
      `[stt] REJECTED /listen: token invalid or expired (len=${token.length}, model=${url.searchParams.get('model') ?? 'default'}). ` +
        `If this is every request, the broker and this Worker disagree about STT_SIGNING_SECRET.`,
    )
    return new Response('unauthorized\n', { status: 401 })
  }

  const spec = resolveModel(url.searchParams.get('model'))
  const inputs = upstreamInputs(spec, url.searchParams)
  const log = (line: string) => console.log(`[stt] user=${claims.user} model=${spec.id} ${line}`)

  let upstream: WebSocket
  const dialStart = Date.now()
  try {
    upstream = await dialUpstream(env, spec, inputs)
    log(`upstream dialled in ${Date.now() - dialStart}ms`)
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 502
    log(`upstream dial FAILED after ${Date.now() - dialStart}ms: ${err instanceof Error ? err.message : err}`)
    return new Response('speech backend unavailable\n', { status: 502, headers: { 'x-upstream-status': `${status}` } })
  }

  const pair = new WebSocketPair()
  const [browser, worker] = Object.values(pair) as [WebSocket, WebSocket]
  acceptBinary(worker)
  log(`session start inputs=${JSON.stringify(inputs)}`)
  pipeSession(worker, upstream, spec, log)

  return new Response(null, { status: 101, webSocket: browser })
}
