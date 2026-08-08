#!/usr/bin/env bun
/**
 * SPIKE: does `claude --resume` accept a JSONL synthesized by super-compact?
 *
 * `src/agent-host-common/super-compact/` claims its output is "a fresh session
 * with a clean parent chain, ready for an adapter to serialize and a host to
 * --resume". 10 green unit tests prove the FOLD; nothing proves CC swallows the
 * result. That assumption is the only thing standing between us and a
 * zero-cost "Fork compacted" mode, so it gets answered before anything is built
 * on top of it.
 *
 * What this does:
 *   1. Reads a REAL transcript (read-only) from the live CC config dir.
 *   2. Folds it via runCompaction() into a fresh <newSessionId>.jsonl.
 *   3. Writes ONLY that one new file next to the original (additive; CC creates
 *      files there constantly). Never touches the source.
 *   4. Runs `claude --resume <newSessionId> -p ...` and reports whether CC
 *      accepted the chain and whether the folded context survived.
 *   5. Deletes the file it created, unless --keep.
 *
 * Usage:
 *   bun scripts/spike-fork-supercompact.ts <sourceJsonlPath> [--keep] [--no-run]
 */

import { rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { FileReader, FileWriter, runCompaction } from '../src/agent-host-common/super-compact'
import { ClaudeCodeAdapter } from '../src/agent-host-common/super-compact/claude-code-adapter'

const args = process.argv.slice(2)
const source = args.find(a => !a.startsWith('--'))
const keep = args.includes('--keep')
const noRun = args.includes('--no-run')

if (!source) {
  console.error('usage: bun scripts/spike-fork-supercompact.ts <sourceJsonlPath> [--keep] [--no-run]')
  process.exit(2)
}

const newSessionId = crypto.randomUUID()
const outDir = dirname(source)
const outPath = join(outDir, `${newSessionId}.jsonl`)
const parentSessionId = basename(source).replace(/\.jsonl$/, '')

console.log(`source        ${source}`)
console.log(`parent        ${parentSessionId}`)
console.log(`fork          ${newSessionId}`)
console.log(`out           ${outPath}`)
console.log('')

const stats = await runCompaction(new FileReader(source), new FileWriter(outPath), new ClaudeCodeAdapter(), {
  newSessionId,
  parentRef: { sessionId: parentSessionId, path: source },
})

const s = stats.stats
const pct = s.beforeTokens > 0 ? Math.round((1 - s.afterTokens / s.beforeTokens) * 100) : 0
console.log('--- fold ---')
console.log(`tokens        ${s.beforeTokens} -> ${s.afterTokens}  (-${pct}%)`)
console.log(`entries       ${s.entriesBefore} -> ${s.entriesAfter}`)
console.log(`thinking      ${s.droppedThinking} dropped`)
console.log(`reads         ${s.collapsedReads} collapsed`)
console.log(`results       ${s.digestedResults} digested`)
console.log(`tail          ${s.tailEntries} verbatim`)
console.log(`bytes         ${Bun.file(source).size} -> ${Bun.file(outPath).size}`)
console.log('')

// CC slugs the transcript dir from the cwd it is launched in, so the spike must
// run from the cwd the source session claims or --resume looks in a different
// directory entirely. Not every entry carries cwd (summary/meta lines do not),
// so scan for the first one that does rather than trusting line 0.
let runCwd = ''
for (const line of (await Bun.file(source).text()).split('\n')) {
  if (!line.trim()) continue
  try {
    const parsed = JSON.parse(line) as { cwd?: string }
    if (parsed.cwd) {
      runCwd = parsed.cwd
      break
    }
  } catch {
    // Skip unparseable lines; the next one may carry cwd.
  }
}
if (!runCwd) {
  console.error('FAIL: no entry in the source transcript carries a cwd -- cannot pick a run directory')
  cleanup()
  process.exit(1)
}
console.log(`run cwd       ${runCwd}`)

function cleanup() {
  if (keep) {
    console.log(`\nKEPT ${outPath}`)
    return
  }
  rmSync(outPath, { force: true })
  console.log(`\nremoved ${outPath}`)
}

if (noRun) {
  console.log('\n--no-run: skipping the claude invocation')
  cleanup()
  process.exit(0)
}

console.log('\n--- claude --resume ---')
const proc = Bun.spawn(
  [
    'claude',
    '--resume',
    newSessionId,
    '-p',
    'In one sentence: what was the LAST thing being worked on in this session, and what file was it in? Answer only from the conversation you have been resumed with.',
    '--output-format',
    'json',
  ],
  { cwd: runCwd, stdout: 'pipe', stderr: 'pipe' },
)

const [out, err, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
])

console.log(`exit          ${code}`)
if (err.trim()) console.log(`stderr        ${err.trim().slice(0, 1200)}`)

if (code === 0) {
  try {
    // CC 2.1.221 returns an ARRAY of stream events here (not the single object
    // `--output-format json` implies). The terminal `result` event is the answer;
    // the `init` event proves which session id CC actually resumed.
    type Ev = { type?: string; subtype?: string; result?: string; session_id?: string; total_cost_usd?: number }
    const raw = JSON.parse(out) as Ev | Ev[]
    const events: Ev[] = Array.isArray(raw) ? raw : [raw]
    const init = events.find(e => e.type === 'system' && e.subtype === 'init')
    const result = events.find(e => e.result !== undefined) ?? events.at(-1)

    console.log(`resumed as    ${init?.session_id ?? '(no init event)'}`)
    console.log(
      `match fork?   ${init?.session_id === newSessionId ? 'YES -- CC accepted the synthesized chain' : 'NO'}`,
    )
    console.log(`cost          $${result?.total_cost_usd?.toFixed(4) ?? '?'}`)
    console.log(`\nRESULT:\n${result?.result ?? '(no result event)'}`)
  } catch {
    console.log(`raw stdout    ${out.slice(0, 2000)}`)
  }
} else {
  console.log(`raw stdout    ${out.slice(0, 2000)}`)
}

cleanup()
