/**
 * CONTRACT: Bun.spawn stdio-pipe (headless) behavior.
 *
 * Mirrors claude-agent-host/stream-backend.ts (and the opencode/acp hosts):
 * spawn with stdin/stdout/stderr = 'pipe', write NDJSON to stdin, read NDJSON
 * back from stdout via getReader()+TextDecoder, capture stderr separately, and
 * observe the exit code.
 */

import { describe, expect, test } from 'bun:test'
import { pumpToString, waitFor } from './_helpers'

// NDJSON echo child: {type:'ping',n} -> {type:'pong',echo:n}; {type:'bye'} ->
// writes to stderr then exits 0.
const CHILD = [
  'let buf = "";',
  'process.stdin.on("data", (d) => {',
  '  buf += d.toString();',
  '  let i;',
  '  while ((i = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
  '    if (!line.trim()) continue;',
  '    let m; try { m = JSON.parse(line); } catch { continue; }',
  '    if (m.type === "ping") process.stdout.write(JSON.stringify({ type: "pong", echo: m.n }) + "\\n");',
  '    else if (m.type === "bye") { process.stderr.write("goodbye\\n"); process.exit(0); }',
  '  }',
  '});',
].join('\n')

describe('Bun.spawn headless stdio contract', () => {
  test('NDJSON round-trip over stdin/stdout, stderr captured, clean exit', async () => {
    const proc = Bun.spawn(['bun', '-e', CHILD], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = pumpToString(proc.stdout as ReadableStream<Uint8Array>)
    const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text()

    // stdin is a writable FileSink: write a line, flush so the child sees it now.
    const sink = proc.stdin as { write: (s: string) => void; flush: () => void; end: () => void }
    sink.write(`${JSON.stringify({ type: 'ping', n: 42 })}\n`)
    sink.flush()

    await waitFor(() => stdout.read().includes('"echo":42'), { label: 'pong echo:42' })
    const reply = JSON.parse(stdout.read().trim().split('\n')[0])
    expect(reply).toEqual({ type: 'pong', echo: 42 })

    sink.write(`${JSON.stringify({ type: 'bye' })}\n`)
    sink.flush()

    const code = await proc.exited
    expect(code).toBe(0)
    expect(await stderrText).toContain('goodbye')
    await stdout.done
  })
})
