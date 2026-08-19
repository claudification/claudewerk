/**
 * WorktreeCreate must survive REUSING an existing worktree.
 *
 * The regression: the idempotency lookup piped `git worktree list --porcelain`
 * into an awk that `exit`ed on the first match. git was still writing, took
 * SIGPIPE and died 141; `pipefail` promoted it, `set -e` aborted the script --
 * and because it happens inside a command-substitution assignment, bash printed
 * NOTHING. Exit 141, empty stderr, and the sentinel could only report "early
 * failure". Every spawn into an existing worktree died: bounced-card redispatch,
 * chain-protocol phases, any hand-launch at an existing path.
 *
 * WHY THE STUB GIT, and why it emits thousands of lines: SIGPIPE only fires if
 * the writer still has bytes buffered when the reader leaves. A temp repo with
 * three worktrees fits inside the 64 KB pipe buffer, git finishes before awk
 * exits, and the bug DOES NOT REPRODUCE -- a green test there proves nothing.
 * So we stub `git` on PATH with a writer big enough to block, and put the target
 * near the FRONT so awk leaves early. That exercises the real script and the real
 * pipeline, and stays fast.
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'worktree-create.sh')

const WT_NAME = 'epic/some-epic/some-card'
const BRANCH = `worktree-${WT_NAME}`
/** Enough porcelain to overrun the 64 KB pipe buffer; the bug needs a blocked writer. */
const FILLER_WORKTREES = 4000

/**
 * A `git` that answers only what the hook asks, with one honest detail: its
 * `worktree list --porcelain` is huge and lists the target FIRST.
 */
function makeStubGit(dir: string, root: string, targetPath: string): void {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const stub = `#!/bin/bash
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${root}"; exit 0 ;;
  "branch --show-current") echo "main"; exit 0 ;;
esac
if [[ "$1" == "worktree" && "$2" == "list" ]]; then
  # Target FIRST so awk can leave while this is still writing.
  echo "worktree ${targetPath}"
  echo "HEAD 0000000000000000000000000000000000000000"
  echo "branch refs/heads/${BRANCH}"
  echo
  for i in $(seq 1 ${FILLER_WORKTREES}); do
    echo "worktree ${root}/.claude/worktrees/filler-$i"
    echo "HEAD 0000000000000000000000000000000000000000"
    echo "branch refs/heads/worktree-filler-$i"
    echo
  done
  exit 0
fi
if [[ "$1" == "rev-parse" ]]; then echo "0000000000000000000000000000000000000000"; exit 0; fi
exit 0
`
  const p = join(bin, 'git')
  writeFileSync(p, stub)
  chmodSync(p, 0o755)
}

function runHook(): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wt-reuse-'))
  const root = join(dir, 'repo')
  const targetPath = join(root, '.claude', 'worktrees', WT_NAME)
  mkdirSync(targetPath, { recursive: true })
  makeStubGit(dir, root, targetPath)

  const res = Bun.spawnSync(['bash', SCRIPT], {
    stdin: Buffer.from(JSON.stringify({ name: WT_NAME, cwd: root })),
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
  })
  return {
    code: res.exitCode,
    stdout: new TextDecoder().decode(res.stdout).trim(),
    stderr: new TextDecoder().decode(res.stderr),
  }
}

describe('worktree-create.sh reusing an existing worktree', () => {
  test('exits 0 and prints the worktree path instead of dying on SIGPIPE', () => {
    const { code, stdout, stderr } = runHook()

    // 141 here is the regression, and it arrives with an EMPTY stderr -- assert
    // the code explicitly so a failure names the bug rather than a diff.
    expect(code).not.toBe(141)
    expect(code).toBe(0)
    expect(stdout).toEndWith(join('.claude', 'worktrees', WT_NAME))
    expect(stderr).toContain('REUSE existing worktree')
  })

  test('recognises the existing branch rather than trying to create it', () => {
    const { stderr } = runHook()
    // ATTACH or `worktree add` here would mean the lookup returned empty --
    // i.e. it swallowed the match and fell through to the create path.
    expect(stderr).toContain(`branch=${BRANCH}`)
    expect(stderr).not.toContain('ATTACH existing branch')
  })
})
