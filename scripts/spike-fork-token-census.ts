#!/usr/bin/env bun
/**
 * Where do a long session's tokens actually LIVE?
 *
 * The live spike proved super-compact's output is CC-resumable, but the fold is
 * only ~14% even on a 675k-token session. This census explains the ceiling: the
 * current strategies are deliberately pair-safe and only touch (a) thinking
 * blocks and (b) Read results superseded by a LATER touch of the same file.
 * Everything else -- one-shot Reads, Bash output, Grep, test runs -- is kept
 * verbatim forever.
 *
 * This measures the size of that untouched mass so we can price a
 * `digestLargeToolResults` strategy BEFORE writing it. Digesting a tool_result's
 * content is already proven pair-safe by collapseSupersededReads.
 *
 * Usage: bun scripts/spike-fork-token-census.ts <jsonlPath...>
 */

import { ClaudeCodeAdapter } from '../src/agent-host-common/super-compact/claude-code-adapter'
import { isMessageEntry } from '../src/agent-host-common/super-compact/model'
import { estimateTokens } from '../src/agent-host-common/super-compact/tokens'

const paths = process.argv.slice(2).filter(a => !a.startsWith('--'))
if (paths.length === 0) {
  console.error('usage: bun scripts/spike-fork-token-census.ts <jsonlPath...>')
  process.exit(2)
}

/** Threshold above which a single tool_result is a digest candidate. */
const BIG = 500

for (const path of paths) {
  const adapter = new ClaudeCodeAdapter()
  const transcript = adapter.parse(await Bun.file(path).text())
  const msgs = transcript.entries.filter(isMessageEntry)

  const byKind: Record<string, number> = { text: 0, thinking: 0, tool_use: 0, tool_result: 0 }
  const byTool: Record<string, number> = {}
  let bigResultTokens = 0
  let bigResultCount = 0

  // tool_use id -> tool name, so a tool_result can be attributed to its tool.
  const toolNameById = new Map<string, string>()
  for (const e of msgs) {
    for (const b of e.blocks ?? []) {
      if (b.kind === 'tool_use') toolNameById.set(b.id, b.name)
    }
  }

  for (const e of msgs) {
    for (const b of e.blocks ?? []) {
      const text =
        b.kind === 'text' || b.kind === 'thinking'
          ? b.text
          : b.kind === 'tool_use'
            ? JSON.stringify(b.input ?? '')
            : typeof b.content === 'string'
              ? b.content
              : JSON.stringify(b.content ?? '')
      const t = estimateTokens(text)
      byKind[b.kind] += t
      if (b.kind === 'tool_result') {
        const name = toolNameById.get(b.toolUseId) ?? '(unpaired)'
        byTool[name] = (byTool[name] ?? 0) + t
        if (t > BIG) {
          bigResultTokens += t
          bigResultCount++
        }
      }
    }
  }

  const total = Object.values(byKind).reduce((a, b) => a + b, 0)
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`

  console.log(`\n=== ${path.split('/').pop()}  (${total.toLocaleString()} tokens, ${msgs.length} messages)`)
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${v.toLocaleString().padStart(9)}  ${pct(v).padStart(6)}`)
  }
  console.log(`  -- tool_result by tool --`)
  for (const [k, v] of Object.entries(byTool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)) {
    console.log(`  ${k.padEnd(12)} ${v.toLocaleString().padStart(9)}  ${pct(v).padStart(6)}`)
  }
  console.log(
    `  HEADROOM: ${bigResultCount} results >${BIG}tok hold ${bigResultTokens.toLocaleString()} (${pct(bigResultTokens)}); digesting them to ~30tok each frees ~${pct(bigResultTokens - bigResultCount * 30)}`,
  )
}
