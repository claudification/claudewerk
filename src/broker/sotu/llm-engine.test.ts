import { expect, test } from 'bun:test'
import * as engine from './llm-engine'
import { computeCostUsd, normalizeUsage, RecapLedger } from './llm-engine'

// The seam's whole job is to re-export recap's LLM plumbing read-only. These
// assertions fail loudly if a re-export name drifts when recap-chunked churns
// pricing.ts / ledger.ts / openrouter-client.ts (OPEN ITEM #6).

test('seam re-exports the OpenRouter + pricing + ledger primitives', () => {
  expect(typeof engine.chat).toBe('function')
  expect(typeof normalizeUsage).toBe('function')
  expect(typeof computeCostUsd).toBe('function')
  expect(typeof RecapLedger).toBe('function')
  expect(typeof engine.findFirstJsonObject).toBe('function')
  expect(typeof engine.RECAP_LEDGER_VERSION).toBe('number')
})

test('re-exported pricing primitive is callable through the seam', () => {
  const usage = normalizeUsage('unknown/model', undefined)
  expect(usage.inputTokens).toBe(0)
  expect(usage.costSource).toBe('unknown')
})
