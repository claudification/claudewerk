/**
 * upstream - open the Workers AI speech socket from inside the Worker.
 *
 * Uses the AI BINDING (`env.AI.run(model, inputs, { websocket: true })`), not an
 * HTTP call to api.cloudflare.com. That means **no account token anywhere in this
 * Worker** and no egress: the binding is authorised by the deployment itself.
 * A leaked secret cannot happen if there is no secret.
 *
 * The binding hands back a `Response`; the socket is on `.webSocket`, the same
 * shape as a `fetch` upgrade.
 */

import type { ModelSpec } from './models'

export interface Env {
  AI: Ai
  /** Shared with the broker, which signs the tokens this Worker verifies. */
  STT_SIGNING_SECRET: string
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function dialUpstream(env: Env, spec: ModelSpec, inputs: Record<string, string>): Promise<WebSocket> {
  // `inputs` is validated by models.ts against the model's own allowlist; the
  // cast is only because that allowlist is data, not a compile-time literal.
  const res = await env.AI.run(spec.id, inputs as never, { websocket: true })

  const socket = res.webSocket
  if (!socket) {
    // Reachable in practice: flux fails the UPGRADE (not a later message) on a
    // bad input set -- with no params at all it is rejected outright. Carry the
    // status, because 401 vs 400 is the entire diagnosis.
    throw new UpstreamError(`workers-ai did not upgrade (status ${res.status})`, res.status)
  }
  // BEFORE accept(), always -- see acceptBinary().
  acceptBinary(socket)
  return socket
}

/**
 * Accept a socket in ARRAYBUFFER mode. The order is critical and the failure is
 * silent: a Workers WebSocket delivers incoming binary as a **Blob** by default,
 * and forwarding a Blob to the speech model makes it read the audio as a TEXT
 * frame -- "Could not deserialize last text message" -- then close with an empty
 * transcript. Setting `binaryType` AFTER `accept()` appeared to work under
 * `wrangler dev` and did nothing in production, which is the worst way to find
 * out. Set it first, in one helper, so neither socket can drift.
 */
export function acceptBinary(socket: WebSocket): void {
  socket.binaryType = 'arraybuffer'
  socket.accept()
}
