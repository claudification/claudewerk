#!/usr/bin/env bun
/**
 * SWEEP A BOARD'S `test_cmd:` ONTO THE WRAPPER.
 *
 *   bun run board:fix-test-cmd                          # this project, report only
 *   bun run board:fix-test-cmd --root ~/projects/foo    # another board
 *   bun run board:fix-test-cmd --write                  # actually rewrite
 *
 * WHY THIS IS A SCRIPT AND NOT A DOCTOR REPAIR. `card-test-cmd.ts` REPORTS the
 * bare runner and deliberately does not fix it: the doctor's own repairs stamp a
 * missing date and reshape frontmatter, while this one rewrites a command an
 * unattended agent then EXECUTES. That belongs behind a flag somebody typed, not
 * inside a pass that runs on every `board:doctor`.
 *
 * The rule itself is NOT restated here. `hasBareBunTest` / `wrapBareBunTest` are
 * the same functions the write-time check and the doctor call, so a sweep can
 * never disagree with the check that will judge its output.
 *
 * FRONTMATTER ONLY. A card may quote its own `test_cmd:` inside a fenced block
 * in the body as a record of what it said at some generation -- rewriting that
 * would make the record describe a command that was never run.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../src/shared/atomic-write'
import { CARDS_DIR } from '../src/shared/card-path'
import { hasBareBunTest, wrapBareBunTest } from '../src/shared/card-test-cmd'

/** `test_cmd:` and everything after it, on its own line, quotes and all. */
const TEST_CMD_LINE = /^(test_cmd:[ \t]*)(.*)$/

/** The command inside whatever quoting the writer used, plus a way back to it. */
function unquote(raw: string): { command: string; requote: (s: string) => string } {
  const quoted = /^(["'])(.*)\1$/.exec(raw.trim())
  if (!quoted) return { command: raw.trim(), requote: s => s }
  return { command: quoted[2], requote: s => `${quoted[1]}${s}${quoted[1]}` }
}

interface Rewrite {
  card: string
  before: string
  after: string
}

/** One card's new bytes, plus what changed. `null` content means leave it be. */
function sweepCard(id: string, content: string): { content: string; rewrites: Rewrite[] } {
  const rewrites: Rewrite[] = []
  let inFrontmatter = false
  let opened = false
  const lines = content.split('\n').map((line, i) => {
    if (line.trimEnd() === '---') {
      if (i === 0) {
        opened = true
        inFrontmatter = true
      } else if (inFrontmatter) {
        inFrontmatter = false
      }
      return line
    }
    if (!opened || !inFrontmatter) return line
    const match = TEST_CMD_LINE.exec(line)
    if (!match) return line
    const { command, requote } = unquote(match[2])
    if (!hasBareBunTest(command)) return line
    const wrapped = wrapBareBunTest(command)
    rewrites.push({ card: id, before: command, after: wrapped })
    return `${match[1]}${requote(wrapped)}`
  })
  return { content: lines.join('\n'), rewrites }
}

function main(): number {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const rootFlag = argv.indexOf('--root')
  const root = rootFlag === -1 ? process.cwd() : argv[rootFlag + 1]
  if (!root) {
    console.error('--root needs a path')
    return 2
  }

  const dir = join(root, '.rclaude', 'project', CARDS_DIR)
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.md'))
  } catch {
    console.error(`no board at ${dir}`)
    return 2
  }

  let touched = 0
  for (const file of files) {
    const abs = join(dir, file)
    const before = readFileSync(abs, 'utf8')
    const { content, rewrites } = sweepCard(file.replace(/\.md$/, ''), before)
    if (rewrites.length === 0) continue
    touched++
    for (const r of rewrites) console.log(`${r.card}\n  -  ${r.before}\n  +  ${r.after}`)
    if (write) writeFileAtomic(abs, content)
  }

  console.log(`\n${write ? 'rewrote' : 'would rewrite'} ${touched} of ${files.length} cards`)
  if (!write && touched > 0) console.log('re-run with --write to apply')
  return 0
}

process.exit(main())
