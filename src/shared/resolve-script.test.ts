import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveScript } from './resolve-script'
import { secureTmpBase } from './secure-temp'

const isUnix = typeof process.getuid === 'function'

describe('resolveScript embedded extraction', () => {
  let prevXdg: string | undefined
  let prevScripts: string | undefined

  beforeEach(() => {
    prevXdg = process.env.XDG_DATA_HOME
    prevScripts = process.env.RCLAUDE_SCRIPTS
    // Point XDG at an empty dir and clear the override so resolveScript must
    // fall through to the embedded-extraction branch we hardened.
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'xdg-empty-'))
    delete process.env.RCLAUDE_SCRIPTS
  })

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
    if (prevScripts === undefined) delete process.env.RCLAUDE_SCRIPTS
    else process.env.RCLAUDE_SCRIPTS = prevScripts
  })

  test('extracts an embedded script into the owner-only per-uid scripts dir', () => {
    const path = resolveScript('worktree-create.sh')
    expect(path).not.toBeNull()
    const p = path as string
    // Lands under <secure base>/scripts, never bare world-writable /tmp.
    expect(p.startsWith(join(secureTmpBase(), 'scripts'))).toBe(true)
    expect(existsSync(p)).toBe(true)

    if (isUnix) {
      // The script itself is executable...
      expect(statSync(p).mode & 0o111).not.toBe(0)
      // ...but its parent dir is 0700, so no other user can plant a sibling
      // file we would then exec (the old RCE vector).
      expect(statSync(dirname(p)).mode & 0o777).toBe(0o700)
    }
  })

  test('returns the same stable path on a second call (idempotent)', () => {
    const a = resolveScript('worktree-create.sh')
    const b = resolveScript('worktree-create.sh')
    expect(a).toBe(b as string)
  })

  test('returns null for an unknown script with no embedded fallback', () => {
    expect(resolveScript('does-not-exist.sh')).toBeNull()
  })
})
