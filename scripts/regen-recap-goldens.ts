#!/usr/bin/env bun
/**
 * One-shot regenerator for the recap anchor/agent prompt goldens. Mirrors the
 * loops in anchor-prompt.test.ts + agent-prompt.test.ts EXACTLY so key order is
 * preserved. Used to re-capture the goldens after an INTENTIONAL prompt change
 * (plan-broker-cwd-eradication Phase 1: COMMITS header now renders the project
 * label, not a raw cwd path). Run from the repo root: `bun run scripts/regen-recap-goldens.ts`.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makePromptInputs } from '../src/broker/recap/__tests__/synthetic-fixtures'
import { makeEmptyMetadata } from '../src/broker/recap/period/chunk/merge'
import { buildSynthesizePrompt, type SynthesizeContext } from '../src/broker/recap/period/chunk/synthesize-prompt'
import { buildPrompt } from '../src/broker/recap/period/llm/prompt-builder'

const GOLDEN_DIR = join(import.meta.dir, '../src/broker/recap/period/llm/__golden__')

// --- anchor (human) golden ----------------------------------------------------
type AnchorVariant = [name: string, audience: 'human' | 'agent', retrospect: boolean, customerFriendly: boolean]
const ANCHOR_VARIANTS: AnchorVariant[] = [
  ['human-default', 'human', false, false],
  ['human-retro', 'human', true, false],
  ['human-cf', 'human', false, true],
  ['human-retro-cf', 'human', true, true],
  ['agent-default', 'agent', false, false],
]
const anchor: Record<string, { system: string; user: string }> = {}
for (const size of ['small', 'medium'] as const) {
  const inputs = makePromptInputs(size)
  for (const [name, audience, retrospect, customerFriendly] of ANCHOR_VARIANTS) {
    const out = buildPrompt(inputs, audience, retrospect, customerFriendly)
    anchor[`${size}|${name}`] = { system: out.system, user: out.user }
  }
}

// --- agent golden -------------------------------------------------------------
type AgentVariant = [name: string, retrospect: boolean, customerFriendly: boolean]
const AGENT_VARIANTS: AgentVariant[] = [
  ['agent-default', false, false],
  ['agent-retro', true, false],
  ['agent-cf', false, true],
  ['agent-retro-cf', true, true],
]
const SYNTH_CTX: SynthesizeContext = {
  projectLabel: 'remote-claude',
  periodHuman: 'this week',
  periodIsoRange: '2026-05-22..2026-05-29',
}
const agent: Record<string, { system: string; user: string }> = {}
for (const size of ['small', 'medium'] as const) {
  const inputs = makePromptInputs(size)
  for (const [name, retrospect, customerFriendly] of AGENT_VARIANTS) {
    const out = buildPrompt(inputs, 'agent', retrospect, customerFriendly)
    agent[`oneshot|${size}|${name}`] = { system: out.system, user: out.user }
  }
}
for (const [name, retrospect, customerFriendly] of AGENT_VARIANTS) {
  const out = buildSynthesizePrompt(makeEmptyMetadata(), SYNTH_CTX, 'agent', retrospect, customerFriendly)
  agent[`synthesize|${name}`] = { system: out.system, user: out.user }
}

writeFileSync(join(GOLDEN_DIR, 'anchor-prompt.golden.json'), `${JSON.stringify(anchor, null, 2)}\n`)
writeFileSync(join(GOLDEN_DIR, 'agent-prompt.golden.json'), `${JSON.stringify(agent, null, 2)}\n`)
console.log('[regen-recap-goldens] wrote anchor + agent goldens')
