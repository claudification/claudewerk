import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureSecureDir,
  secureTmpBase,
  secureTmpPath,
  secureTmpSubdir,
  tightenFile,
  writeSecureFile,
  writeSecureFileSync,
} from './secure-temp'

const isUnix = typeof process.getuid === 'function'

describe('secureTmpBase', () => {
  test('is namespaced under tmpdir and (on Unix) by uid', () => {
    const base = secureTmpBase()
    expect(base.startsWith(tmpdir())).toBe(true)
    if (isUnix) expect(base.endsWith(`rclaude-${process.getuid?.()}`)).toBe(true)
  })
})

describe('ensureSecureDir', () => {
  test('creates a 0700 directory', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sec-')), 'nested', 'leaf')
    ensureSecureDir(dir)
    expect(existsSync(dir)).toBe(true)
    if (isUnix) expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('tightens a pre-existing loose-mode directory', () => {
    if (!isUnix) return
    const dir = join(mkdtempSync(join(tmpdir(), 'sec-')), 'loose')
    mkdirSync(dir, { mode: 0o777 })
    // mkdir mode is umask-masked; force it loose to simulate an attacker-friendly dir.
    require('node:fs').chmodSync(dir, 0o777)
    expect(statSync(dir).mode & 0o077).not.toBe(0)
    ensureSecureDir(dir)
    expect(statSync(dir).mode & 0o077).toBe(0)
  })

  test('rejects a symlinked dir (pre-create attack)', () => {
    if (!isUnix) return
    const root = mkdtempSync(join(tmpdir(), 'sec-'))
    const real = join(root, 'real')
    mkdirSync(real)
    const link = join(root, 'link')
    symlinkSync(real, link)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(() => ensureSecureDir(link)).toThrow(/symlink/)
  })

  test('rejects a path that is a file, not a dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'sec-'))
    const file = join(root, 'afile')
    writeFileSync(file, 'x')
    expect(() => ensureSecureDir(file)).toThrow(/not a directory/)
  })
})

describe('secureTmpPath / secureTmpSubdir', () => {
  test('secureTmpPath returns a path inside the secured base', () => {
    const p = secureTmpPath('probe.txt')
    expect(p).toBe(join(secureTmpBase(), 'probe.txt'))
    if (isUnix) expect(statSync(secureTmpBase()).mode & 0o777).toBe(0o700)
  })

  test('secureTmpSubdir creates a nested 0700 subdir', () => {
    const d = secureTmpSubdir(join('unit-test-sub', 'x'))
    expect(existsSync(d)).toBe(true)
    if (isUnix) expect(statSync(d).mode & 0o777).toBe(0o700)
  })
})

describe('writeSecureFileSync / writeSecureFile', () => {
  test('writeSecureFileSync creates a 0600 file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'))
    const f = join(dir, 'secret.txt')
    writeSecureFileSync(f, 'token=abc')
    expect(readFileSync(f, 'utf8')).toBe('token=abc')
    if (isUnix) expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  test('writeSecureFileSync tightens a pre-existing world-readable file', () => {
    if (!isUnix) return
    const dir = mkdtempSync(join(tmpdir(), 'sec-'))
    const f = join(dir, 'secret.txt')
    writeFileSync(f, 'old', { mode: 0o644 })
    expect(statSync(f).mode & 0o077).not.toBe(0)
    writeSecureFileSync(f, 'new')
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  test('writeSecureFile (Bun) creates a 0600 file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'))
    const f = join(dir, 'secret.json')
    await writeSecureFile(f, JSON.stringify({ k: 'v' }))
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ k: 'v' })
    if (isUnix) expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  test('tightenFile chmods an existing file to 0600 and ignores missing', () => {
    if (!isUnix) return
    const dir = mkdtempSync(join(tmpdir(), 'sec-'))
    const f = join(dir, 'x')
    writeFileSync(f, 'x', { mode: 0o644 })
    tightenFile(f)
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(() => tightenFile(join(dir, 'nope'))).not.toThrow()
  })
})
