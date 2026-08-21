/**
 * REGRESSION GUARD: no source file may contain a raw 0x00 byte.
 *
 * On 2026-08-21 `src/broker/store/memory/driver.ts` held four literal NUL bytes
 * where the author meant the two-character escape `\0` (and four more files held
 * nine between them). Runtime behaviour is IDENTICAL -- a raw NUL inside a
 * template literal is a perfectly valid string character, every map key still
 * worked, no test failed. The damage was entirely to tooling:
 *
 *   - `grep`/`rg` classify such a file as BINARY. `grep -n "CostStore"
 *     src/broker/store/memory/driver.ts` printed nothing and exited 1, which
 *     reads as "no match" to a human and to an agent. Several tool calls were
 *     burned believing symbols were absent from a file that contains them.
 *   - `git diff` uses the same heuristic on the first 8000 bytes, so a NUL near
 *     the top of a file turns every future diff of it into "Binary files differ".
 *
 * Both failure modes are silent: nothing is thrown, the file just stops being
 * readable by text tools. That is exactly what a fitness test is for.
 *
 * Only code extensions are walked, so genuinely-binary assets (woff2, png, ico)
 * are out of scope by construction rather than by exemption list.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

/** Where source lives. Binary assets under these roots are filtered by extension. */
const ROOTS = ['src', 'web/src']

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git'])

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.html', '.md', '.sh']

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (CODE_EXTENSIONS.some(ext => name.endsWith(ext))) out.push(full)
  }
  return out
}

describe('source files stay readable by text tools', () => {
  test('no raw NUL byte anywhere under src/ or web/src/', () => {
    const offenders: string[] = []

    for (const root of ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const buf = readFileSync(file)
        const at = buf.indexOf(0)
        if (at !== -1) offenders.push(`${file.slice(REPO_ROOT.length + 1)} (first at byte ${at})`)
      }
    }

    // Write `\0`, the two-character escape -- never the byte itself. If this
    // fails: LC_ALL=C perl -0777 -pi -e 's/\x00/\\0/g' <file>
    expect(offenders).toEqual([])
  })
})
