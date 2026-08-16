import { describe, expect, it } from 'vitest'
import { cleanCdPrefix, cleanReplShCalls, shortPath } from './shared'

const ROOT = '/Users/jonas/projects/prox01'

// ---------------------------------------------------------------------------
// Pinned behaviour that predates the widening. These describe what the leading
// `cd` handling did before the sanitizer learned about paths mid-command, and
// must keep passing so the widening is provably additive.
// ---------------------------------------------------------------------------

describe('cleanCdPrefix - leading cd (pre-existing behaviour)', () => {
  it('strips a `cd <root> &&` prefix entirely', () => {
    expect(cleanCdPrefix(`cd ${ROOT} && bun test`, ROOT)).toBe('bun test')
  })

  it('strips a `cd <root>;` prefix entirely', () => {
    expect(cleanCdPrefix(`cd ${ROOT}; bun test`, ROOT)).toBe('bun test')
  })

  it('strips a quoted `cd` prefix', () => {
    expect(cleanCdPrefix(`cd '${ROOT}' && bun test`, ROOT)).toBe('bun test')
    expect(cleanCdPrefix(`cd "${ROOT}" && bun test`, ROOT)).toBe('bun test')
  })

  it('ignores a trailing slash on either side', () => {
    expect(cleanCdPrefix(`cd ${ROOT}/ && bun test`, ROOT)).toBe('bun test')
    expect(cleanCdPrefix(`cd ${ROOT} && bun test`, `${ROOT}/`)).toBe('bun test')
  })

  it('rewrites a subdirectory cd as a relative cd', () => {
    expect(cleanCdPrefix(`cd ${ROOT}/web && bun test`, ROOT)).toBe('cd web && bun test')
  })

  it('leaves an unrelated cd alone', () => {
    expect(cleanCdPrefix('cd /tmp && ls', ROOT)).toBe('cd /tmp && ls')
  })

  it('leaves a command with no cd at all alone', () => {
    expect(cleanCdPrefix('bun test', ROOT)).toBe('bun test')
  })
})

// ---------------------------------------------------------------------------
// The widening. One case per "no" row of the bug card's table -- every one of
// these came back byte-identical to its input before the sanitizer learned to
// look past the first statement.
// ---------------------------------------------------------------------------

describe('cleanCdPrefix - project root anywhere in the command', () => {
  it('handles a cd that is not the first statement', () => {
    expect(cleanCdPrefix(`set -o pipefail; cd ${ROOT} && bun test`, ROOT)).toBe('set -o pipefail; bun test')
  })

  it('shortens the root inside an argument', () => {
    expect(cleanCdPrefix(`mkdir -p ${ROOT}/.claude/temp`, ROOT)).toBe('mkdir -p ./.claude/temp')
  })

  it('shortens the root inside a variable assignment', () => {
    expect(cleanCdPrefix(`D=${ROOT}/evidence/smart`, ROOT)).toBe('D=./evidence/smart')
  })

  it('shortens the root in the command position and in a redirect', () => {
    expect(cleanCdPrefix(`${ROOT}/scripts/run.sh > ${ROOT}/out.log 2>&1`, ROOT)).toBe(
      './scripts/run.sh > ./out.log 2>&1',
    )
  })

  it('shortens the root inside quotes', () => {
    expect(cleanCdPrefix(`cat '${ROOT}/a b.txt'`, ROOT)).toBe("cat './a b.txt'")
  })

  it('shortens a bare root used as an argument', () => {
    expect(cleanCdPrefix(`ls ${ROOT}`, ROOT)).toBe('ls .')
  })

  it('shortens the second and later lines of a multi-line command', () => {
    expect(cleanCdPrefix(`cd ${ROOT} && one\ntwo ${ROOT}/x\nthree ${ROOT}/y`, ROOT)).toBe('one\ntwo ./x\nthree ./y')
  })

  it('never touches a sibling directory whose name merely starts with the root', () => {
    const cmd = `ls ${ROOT}9/x`
    expect(cleanCdPrefix(cmd, ROOT)).toBe(cmd)
  })

  it('never touches a path unrelated to the project root', () => {
    const cmd = 'cat /etc/hosts && ls /Users/jonas/other/thing'
    expect(cleanCdPrefix(cmd, ROOT)).toBe(cmd)
  })

  it('shortens all four occurrences in the command from the bug report', () => {
    const cmd = [
      `set -o pipefail; mkdir -p ${ROOT}/.claude/temp`,
      `D=${ROOT}/lazada-dispute/evidence/smart`,
      `OUT=${ROOT}/.claude/temp`,
      'timeout 300 ssh farm@host "cat $D/x" > $OUT/farm-WS24PTWP.txt 2>&1',
    ].join('\n')
    expect(cleanCdPrefix(cmd, ROOT)).toBe(
      [
        'set -o pipefail; mkdir -p ./.claude/temp',
        'D=./lazada-dispute/evidence/smart',
        'OUT=./.claude/temp',
        'timeout 300 ssh farm@host "cat $D/x" > $OUT/farm-WS24PTWP.txt 2>&1',
      ].join('\n'),
    )
    expect(cleanCdPrefix(cmd, ROOT)).not.toContain(ROOT)
  })
})

describe('shortPath', () => {
  it('strips the /Users/<user>/projects/<project>/ prefix', () => {
    expect(shortPath(`${ROOT}/.claude/temp`)).toBe('.claude/temp')
  })

  it('strips a bare home prefix outside projects/', () => {
    expect(shortPath('/Users/jonas/notes/todo.md')).toBe('notes/todo.md')
    expect(shortPath('/home/jonas/notes/todo.md')).toBe('notes/todo.md')
  })

  it('keeps the last three segments of an unrelated absolute path', () => {
    expect(shortPath('/etc/nginx/conf/site.conf')).toBe('nginx/conf/site.conf')
  })

  it('leaves a short absolute path and any relative path untouched', () => {
    expect(shortPath('/tmp/a')).toBe('/tmp/a')
    expect(shortPath('src/main.tsx')).toBe('src/main.tsx')
    expect(shortPath('')).toBe('')
  })
})

describe('cleanReplShCalls', () => {
  it('drops a chdir() line that is a no-op', () => {
    expect(cleanReplShCalls(`chdir('${ROOT}');\nsh('ls')`, ROOT)).toBe("sh('ls')")
  })

  it('keeps a chdir() line pointing somewhere else', () => {
    const code = `chdir('/tmp');\nsh('ls')`
    expect(cleanReplShCalls(code, ROOT)).toBe(code)
  })

  it('strips the cd prefix inside an sh() call', () => {
    expect(cleanReplShCalls(`sh('cd ${ROOT} && ls')`, ROOT)).toBe("sh('ls')")
  })

  it('rewrites a subdirectory cd inside an sh() call', () => {
    expect(cleanReplShCalls(`sh('cd ${ROOT}/web && ls')`, ROOT)).toBe("sh('cd web && ls')")
  })
})
