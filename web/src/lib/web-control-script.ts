/**
 * Web Debug Control -- execute_script runner (client side).
 *
 * Runs agent-supplied JS in THIS page (window / document / app stores in scope) as
 * the body of an async function, so the code can `await` and `return` a value.
 * STRICTLY gated upstream: a SEPARATE "Allow script execution" opt-in (advertised
 * only when on), benevolent-only at the broker relay, host-MCP-only. Every run is
 * logged to the debug log so the USER sees exactly what the agent ran.
 *
 * TIMEOUT races the async work; it CANNOT preempt a SYNCHRONOUS infinite loop
 * (single-threaded, and the code needs DOM access so a Worker is out). Accepted
 * risk -- mitigated by benevolent-only + audit.
 */

import { describeError } from './web-control-log'

const OUTPUT_CAP = 256 * 1024

/** Return the value if JSON-serializable, else its String() form. */
function jsonSafe(value: unknown): unknown {
  try {
    JSON.stringify(value)
    return value
  } catch {
    return String(value)
  }
}

/** Cap a serialized result so a giant DOM dump can't flood the agent's context. */
function capResult(value: unknown): unknown {
  const serialized = JSON.stringify(value)
  if (serialized && serialized.length > OUTPUT_CAP) {
    return `${serialized.slice(0, OUTPUT_CAP)}… [truncated ${serialized.length - OUTPUT_CAP} chars]`
  }
  return value
}

export async function runScript(code: string, timeoutMs: number): Promise<{ result?: unknown; error?: string }> {
  const preview = code.length > 120 ? `${code.slice(0, 120)}…` : code
  console.debug(`[web-control] execute_script (${code.length} chars, ${timeoutMs}ms): ${preview}`)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`script timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    // Gated, intentional eval. Body of an async fn so `await`/`return` work.
    // react-doctor-disable-next-line react-doctor/no-eval -- intentional: sandboxed script runner for web-control debug feature, gated by opt-in + benevolent-only + audit
    const fn = new Function(`return (async () => { ${code} })()`) as () => unknown
    // Promise.resolve().then adopts a returned promise/thenable, so the race bounds
    // the WHOLE async chain (including a returned thenable), not just the first tick.
    const run = Promise.resolve().then(() => fn())
    const result = await Promise.race([run, timeout])
    console.debug('[web-control] execute_script -> ok')
    return { result: capResult(jsonSafe(result)) }
  } catch (e) {
    const error = describeError(e)
    console.debug(`[web-control] execute_script -> error: ${error}`)
    return { error }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
