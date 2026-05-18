/**
 * In-process fake of the Claude Code daemon control socket, for Tier 1 unit
 * tests (see `.claude/docs/plan-claude-agents-integration.md` section 10).
 *
 * It exercises the real `cc-daemon` framing end to end -- newline-JSON over a
 * Unix socket -- without a real `claude` install or a live daemon. The handler
 * decides each response, so a test can simulate ok frames, error frames,
 * EPROTO, held `subscribe` streams, and partial-chunk delivery.
 *
 * Test support only. Never imported by shipping code.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A live connection the handler can answer on. */
export interface FakeConn {
  /** Write one newline-JSON frame. */
  send(obj: unknown): void
  /** Write a raw string (for partial-frame / malformed-input tests). */
  raw(text: string): void
  /** Write raw bytes (for attach PTY-stream tests). */
  rawBytes(data: Buffer): void
  /** Close the connection. */
  end(): void
  /**
   * Register a sink for raw bytes the client sends AFTER its first request
   * line -- i.e. attach PTY input. Set by an `attach` handler.
   */
  onInput?: (data: Buffer) => void
}

/** Decides how the fake daemon answers one request frame. */
export type FakeHandler = (req: Record<string, unknown>, conn: FakeConn) => void

export interface FakeDaemon {
  /** Path to the fake `control.sock`. */
  sockPath: string
  /** Stop listening and remove the temp socket dir. */
  close(): Promise<void>
}

/** Start a fake daemon; resolves once it is listening. */
export function startFakeDaemon(handler: FakeHandler): Promise<FakeDaemon> {
  const dir = mkdtempSync(join(tmpdir(), 'cc-daemon-test-'))
  const sockPath = join(dir, 'control.sock')

  const server: Server = createServer(socket => {
    let buf = ''
    let requestDispatched = false
    const conn: FakeConn = {
      send: obj => socket.write(`${JSON.stringify(obj)}\n`),
      raw: text => socket.write(text),
      rawBytes: data => socket.write(data),
      end: () => socket.end(),
    }
    socket.on('data', (chunk: Buffer) => {
      // Once the first request line is dispatched, treat further bytes as raw
      // input (attach PTY input) and hand them to the handler-registered sink.
      if (requestDispatched) {
        conn.onInput?.(chunk)
        return
      }
      buf += chunk.toString()
      const nl = buf.indexOf('\n')
      if (nl < 0) return // wait for a complete request line
      const line = buf.slice(0, nl)
      const leftover = buf.slice(nl + 1)
      requestDispatched = true
      let req: Record<string, unknown>
      try {
        req = JSON.parse(line) as Record<string, unknown>
      } catch {
        socket.end()
        return
      }
      handler(req, conn)
      if (leftover.length > 0) conn.onInput?.(Buffer.from(leftover))
    })
    socket.on('error', () => {}) // client hang-ups are expected in tests
  })

  return new Promise<FakeDaemon>((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, () => {
      resolve({
        sockPath,
        close: () =>
          new Promise<void>(res => {
            server.close(() => {
              rmSync(dir, { recursive: true, force: true })
              res()
            })
          }),
      })
    })
  })
}
