/**
 * Shared source-file scanning for the lint scripts.
 *
 * The point of this module is the build-artifact filter. `web/dist/` is
 * gitignored build output, but Vite COPIES `web/public/` into it verbatim --
 * so a stale `web/dist/` contains real-looking `.ts` files (including test
 * files) that no longer match source. A lint that walks them reports findings
 * against generated code that cannot be fixed, and the result depends on
 * whether someone happened to run a build. Always scan source, never output.
 */

import { Glob } from 'bun'

/** Path segments that mean "generated or vendored, not source". */
const BUILD_ARTIFACT_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git'])

/** True if any segment of `relPath` names a build-artifact directory. */
export function isBuildArtifact(relPath: string): boolean {
  return relPath.split('/').some(segment => BUILD_ARTIFACT_DIRS.has(segment))
}

/**
 * Relative paths of source files under `absDir` matching `pattern`,
 * excluding build artifacts.
 */
export function scanSourceFiles(absDir: string, pattern: string): string[] {
  const glob = new Glob(pattern)
  const out: string[] = []
  for (const rel of glob.scanSync({ cwd: absDir, absolute: false })) {
    if (!isBuildArtifact(rel)) out.push(rel)
  }
  return out
}
