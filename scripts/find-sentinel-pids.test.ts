/**
 * Regression test for the 2026-08-17 mass-kill.
 *
 * `start-sentinel.sh --kill-if-running` looked for orphaned sentinels with
 * `ps aux | grep "[b]un.*sentinel"`. That is a substring match against the WHOLE
 * command line, and an agent host carries several KB of `--append-system-prompt`
 * text that mentions both "bundle" and "sentinel". Six live conversations
 * matched and were killed -- all of them claudewerk ones, because only those
 * carry a system prompt that describes the sentinel.
 *
 * The fixture below is the real shape of the command line that got killed.
 */

import { describe, expect, test } from 'bun:test'

const SCRIPT = new URL('./find-sentinel-pids.sh', import.meta.url).pathname

async function findPids(psOutput: string): Promise<string[]> {
  const proc = Bun.spawn(['bash', SCRIPT], { stdin: new TextEncoder().encode(psOutput), stdout: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.split('\n').filter(Boolean)
}

/**
 * The killer, with the REAL word order that did it. `[b]un.*sentinel` needs
 * "bun" BEFORE "sentinel" on the line: "bundle" supplies the first, the later
 * lowercase "fseventsd/sentinel" the second. Reorder these two and the old
 * matcher misses -- which is exactly why only some conversations died and the
 * bug looked arbitrary.
 */
const AGENT_HOST_LINE =
  '15177 claude --print --output-format stream-json --name ninja-biscuit ' +
  '--append-system-prompt ## State of the Union ... Found + fixed sentinel bundle stale ' +
  '(predated epic support by 29 min) ... fseventsd/sentinel leak (watchdog built) ...'

describe('find-sentinel-pids', () => {
  test('finds a sentinel started from the bun global bin', async () => {
    expect(await findPids('8901 bun /Users/jonas/.bun/bin/sentinel\n')).toEqual(['8901'])
  })

  test('finds a sentinel started from the package path', async () => {
    expect(await findPids('123 bun /repo/packages/sentinel/bin/sentinel --verbose\n')).toEqual(['123'])
  })

  test('DOES NOT match an agent host whose system prompt says bundle and sentinel', async () => {
    expect(await findPids(`${AGENT_HOST_LINE}\n`)).toEqual([])
  })

  test('picks the sentinel out of a mixed process table, killing nothing else', async () => {
    const table = [
      AGENT_HOST_LINE,
      '8901 bun /Users/jonas/.bun/bin/sentinel',
      '4242 node /usr/local/lib/sentinel-dashboard/server.js',
      '777 /usr/bin/bundler exec sentinel',
      '999 bun /repo/scripts/deploy-sentinel-docs.ts',
    ].join('\n')
    expect(await findPids(`${table}\n`)).toEqual(['8901'])
  })

  test('does not match a bun script that merely has sentinel in its name', async () => {
    expect(await findPids('999 bun /repo/scripts/sentinel-watchdog.ts\n')).toEqual([])
  })

  test('ignores a blank table rather than emitting a stray pid', async () => {
    expect(await findPids('\n\n')).toEqual([])
  })

  test('survives a login shell, whose argv0 is a flag as far as basename cares', async () => {
    // `basename -zsh` reads the dash as an option and errors out; ${var##*/}
    // does not. A real process table always contains one of these.
    expect(await findPids('501 -zsh\n8901 bun /Users/jonas/.bun/bin/sentinel\n')).toEqual(['8901'])
  })

  test('ignores a lone pid with no program, rather than treating it as a match', async () => {
    expect(await findPids('501 bun\n')).toEqual([])
  })
})
