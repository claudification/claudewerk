import { describe, expect, test } from 'bun:test'
import { minSize, RingBuffer, resolveShellCommand, ShellRegistry, scrubShellEnv } from './shell-pty'

// Wait until `predicate()` is truthy or the timeout elapses. Real-PTY tests are
// inherently async (output + exit arrive on the event loop); polling keeps them
// deterministic without arbitrary fixed sleeps.
async function waitFor(predicate: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(stepMs)
  }
}

describe('scrubShellEnv', () => {
  test('strips fleet credentials, account routing, and generic secrets', () => {
    const out = scrubShellEnv({
      PATH: '/usr/bin',
      HOME: '/home/jonas',
      SHELL: '/bin/zsh',
      // Must be scrubbed:
      CLAUDWERK_SECRET: 'broker-secret',
      CLAUDWERK_SENTINEL_SECRET: 's',
      RCLAUDE_SECRET: 'r',
      RCLAUDE_BROKER: 'ws://broker',
      CLAUDE_CONFIG_DIR: '/home/jonas/.claude-work',
      CLAUDECODE: '1',
      CLAUDE_CODE_TASK_LIST_ID: 'conv_x',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'https://api',
      NPM_TOKEN: 'npm',
      VAPID_PRIVATE_KEY: 'vapid',
      SOME_PASSWORD: 'p',
      AWS_ACCESS_KEY: 'a',
    })
    // Kept:
    expect(out.PATH).toBe('/usr/bin')
    expect(out.HOME).toBe('/home/jonas')
    expect(out.SHELL).toBe('/bin/zsh')
    // Forced:
    expect(out.TERM).toBe('xterm-256color')
    expect(out.COLORTERM).toBe('truecolor')
    // Scrubbed (every credential-bearing key gone):
    for (const k of [
      'CLAUDWERK_SECRET',
      'CLAUDWERK_SENTINEL_SECRET',
      'RCLAUDE_SECRET',
      'RCLAUDE_BROKER',
      'CLAUDE_CONFIG_DIR',
      'CLAUDECODE',
      'CLAUDE_CODE_TASK_LIST_ID',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'NPM_TOKEN',
      'VAPID_PRIVATE_KEY',
      'SOME_PASSWORD',
      'AWS_ACCESS_KEY',
    ]) {
      expect(out[k]).toBeUndefined()
    }
  })

  test('drops undefined values so the result is a clean Record<string,string>', () => {
    const out = scrubShellEnv({ A: 'x', B: undefined })
    expect(out.A).toBe('x')
    expect('B' in out).toBe(false)
  })
})

describe('resolveShellCommand', () => {
  test('honors $SHELL with interactive-login args', () => {
    expect(resolveShellCommand({ SHELL: '/usr/bin/fish' }, 'linux')).toEqual(['/usr/bin/fish', '-l', '-i'])
  })
  test('falls back to /bin/zsh on darwin, /bin/bash elsewhere', () => {
    expect(resolveShellCommand({}, 'darwin')[0]).toBe('/bin/zsh')
    expect(resolveShellCommand({}, 'linux')[0]).toBe('/bin/bash')
    expect(resolveShellCommand({ SHELL: '' }, 'darwin')[0]).toBe('/bin/zsh')
  })
})

describe('minSize (tmux-style)', () => {
  test('empty set returns the fallback', () => {
    expect(minSize([])).toEqual({ cols: 80, rows: 24 })
    expect(minSize([], { cols: 100, rows: 50 })).toEqual({ cols: 100, rows: 50 })
  })
  test('reduces to the per-dimension minimum across viewers', () => {
    expect(
      minSize([
        { cols: 120, rows: 40 },
        { cols: 80, rows: 50 },
        { cols: 100, rows: 24 },
      ]),
    ).toEqual({ cols: 80, rows: 24 })
  })
  test('floors each dimension at 1', () => {
    expect(minSize([{ cols: 0, rows: 0 }])).toEqual({ cols: 1, rows: 1 })
  })
})

describe('RingBuffer', () => {
  test('appends and dumps in order', () => {
    const r = new RingBuffer(1024)
    r.append('foo')
    r.append('bar')
    expect(r.dump()).toBe('foobar')
    expect(r.byteLength).toBe(6)
  })
  test('evicts oldest chunks once over the byte cap, keeping the tail', () => {
    const r = new RingBuffer(10)
    r.append('aaaaa') // 5
    r.append('bbbbb') // 10 (at cap)
    r.append('ccccc') // 15 -> evict 'aaaaa' -> 10
    const dump = r.dump()
    expect(dump.endsWith('ccccc')).toBe(true)
    expect(dump.includes('aaaaa')).toBe(false)
    expect(r.byteLength).toBeLessThanOrEqual(10)
  })
  test('never evicts the only chunk even if it exceeds the cap', () => {
    const r = new RingBuffer(4)
    r.append('hello world')
    expect(r.dump()).toBe('hello world')
  })
})

describe('ShellRegistry (real PTY)', () => {
  test('lazy stream: no onData until attached, ring captures output, replay dumps it', async () => {
    const reg = new ShellRegistry()
    const dataCalls: string[] = []
    let exitCode: number | null = null
    const id = 'sh_lazy'

    reg.spawn(
      {
        shellId: id,
        projectUri: 'claude://s/tmp',
        path: '/tmp',
        title: 'tmp',
        cols: 80,
        rows: 24,
        argv: ['/bin/sh', '-c', 'printf HELLO_RING; sleep 2'],
      },
      {
        onData: (_id, d) => dataCalls.push(d),
        onExit: (_id, code) => {
          exitCode = code
        },
      },
    )
    expect(reg.count).toBe(1)
    expect(reg.has(id)).toBe(true)

    // printf flushes immediately; give the PTY a beat to deliver it. The ring
    // buffers it but onData must NOT fire -- nobody is attached.
    await Bun.sleep(300)
    expect(dataCalls.length).toBe(0)
    expect(reg.isAttached(id)).toBe(false)

    // Attach -> replay dump carries the buffered scrollback + streaming turns on.
    const dump = reg.attach(id, 100, 30)
    expect(dump).not.toBeNull()
    expect(dump as string).toContain('HELLO_RING')
    expect(reg.isAttached(id)).toBe(true)

    reg.detach(id)
    expect(reg.isAttached(id)).toBe(false)

    reg.kill(id)
    await waitFor(() => exitCode !== null)
    expect(reg.count).toBe(0)
    expect(reg.has(id)).toBe(false)
  })

  test('drainActivity reports dirty shells once, then clears', async () => {
    const reg = new ShellRegistry()
    let exited = false
    const id = 'sh_act'
    reg.spawn(
      {
        shellId: id,
        projectUri: 'claude://s/tmp',
        path: '/tmp',
        title: 'tmp',
        cols: 80,
        rows: 24,
        argv: ['/bin/sh', '-c', 'printf TICK; sleep 2'],
      },
      { onData: () => {}, onExit: () => (exited = true) },
    )

    // The successful drain (predicate) clears the dirty flag; the shell is then
    // sleeping silently, so the next drain reports nothing.
    await waitFor(() => reg.drainActivity().includes(id))
    await Bun.sleep(50)
    expect(reg.drainActivity()).not.toContain(id)

    reg.kill(id)
    await waitFor(() => exited)
  })

  test('rejects a duplicate shellId', () => {
    const reg = new ShellRegistry()
    const opts = {
      shellId: 'dup',
      projectUri: 'claude://s/tmp',
      path: '/tmp',
      title: 'tmp',
      cols: 80,
      rows: 24,
      argv: ['/bin/sh', '-c', 'sleep 2'],
    }
    reg.spawn(opts, { onData: () => {}, onExit: () => {} })
    expect(() => reg.spawn(opts, { onData: () => {}, onExit: () => {} })).toThrow(/already exists/)
    reg.killAll()
  })
})
