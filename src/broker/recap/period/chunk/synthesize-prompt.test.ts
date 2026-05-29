import { describe, expect, it } from 'bun:test'
import type { RecapMetadata } from '../../../../shared/protocol'
import { parseRecapOutput } from '../render/parse-recap'
import { makeEmptyMetadata } from './merge'
import { buildSynthesizePrompt, type SynthesizeContext } from './synthesize-prompt'

const ctx: SynthesizeContext = {
  projectLabel: 'remote-claude',
  periodHuman: 'this week',
  periodIsoRange: '2026-05-22..2026-05-29',
}

function merged(): RecapMetadata {
  const m = makeEmptyMetadata()
  m.keywords = ['chunking', 'ledger']
  m.features = [{ title: 'chunked map-reduce', detail: 'parallel extraction', commits: ['abc1234'] }]
  m.decisions = [{ title: 'JSON map stage', inferred: true }]
  return m
}

describe('buildSynthesizePrompt', () => {
  it('embeds the frontmatter contract + the dedup/synthesis framing', () => {
    const { system } = buildSynthesizePrompt(merged(), ctx)
    expect(system).toContain('REQUIRED YAML FRONTMATTER')
    expect(system).toContain('SYNTHESIZING')
    expect(system).toContain('JUDGMENT')
    expect(system).toContain('DO NOT invent')
    // round-trip target: it must demand the --- frontmatter + body format
    expect(system).toContain('YAML frontmatter block (between --- lines)')
    expect(system).toContain('remote-claude')
    expect(system).toContain('2026-05-22..2026-05-29')
  })

  it('selects the human body spec by default and the agent body spec for agent audience', () => {
    const human = buildSynthesizePrompt(merged(), ctx, 'human').system
    const agent = buildSynthesizePrompt(merged(), ctx, 'agent').system
    expect(human).toContain('## Features shipped')
    expect(human).toContain('## Notable conversations')
    expect(agent).toContain('## Pick up here')
    expect(agent).toContain('## Dead ends -- do NOT retry')
    expect(human).not.toContain('## Pick up here')
  })

  it('puts the merged facts JSON in the user message (the small input the reduce sees)', () => {
    const { user } = buildSynthesizePrompt(merged(), ctx)
    expect(user).toContain('MERGED FACTS')
    expect(user).toContain('chunked map-reduce')
    expect(user).toContain('abc1234')
    // it is JSON, parseable back out
    const jsonStart = user.indexOf('{')
    const jsonEnd = user.lastIndexOf('}')
    const parsed = JSON.parse(user.slice(jsonStart, jsonEnd + 1)) as RecapMetadata
    expect(parsed.features[0].title).toBe('chunked map-reduce')
  })
})

describe('synthesize output contract round-trips parseRecapOutput', () => {
  // The reduce prompt demands "--- frontmatter --- body". Prove that a response
  // honouring that contract parses cleanly downstream (so the chunked path feeds
  // the SAME finalize as oneshot). This guards the contract the prompt requests.
  it('parses a contract-shaped frontmatter+body block', () => {
    const out = `---
subtitle: chunked recap engine landed
keywords: [chunking, ledger]
features:
  - title: chunked map-reduce
    detail: parallel extraction then code merge
    commits: [abc1234]
decisions:
  - title: [inferred] JSON for the map stage
---
## TL;DR
- Shipped the chunked map-reduce path.

## Features shipped
- chunked map-reduce (abc1234)
`
    const { metadata, body } = parseRecapOutput(out)
    expect(metadata.subtitle).toBe('chunked recap engine landed')
    expect(metadata.keywords).toEqual(['chunking', 'ledger'])
    expect(metadata.features[0].title).toBe('chunked map-reduce')
    expect(metadata.features[0].commits).toEqual(['abc1234'])
    expect(metadata.decisions[0].inferred).toBe(true)
    expect(body).toContain('## TL;DR')
  })
})
