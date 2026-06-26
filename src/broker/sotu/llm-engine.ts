/**
 * SOTU <-> shared LLM-engine seam (Phase 0).
 *
 * SOTU's distill engine (Phase 4) is recap's chunked map-reduce wearing a
 * different hat: SCRIBE fold = recap's cheap intermediary, RECONCILE = recap's
 * Opus final. So SOTU does NOT reinvent the OpenRouter plumbing -- it CONSUMES
 * recap's, READ-ONLY.
 *
 * This module is the single import surface for that consumption. Every SOTU file
 * that needs the LLM engine imports from HERE, never from deep `recap/...` paths.
 * Two reasons:
 *   1. recap-chunked is actively churning pricing.ts / ledger.ts /
 *      openrouter-client.ts (OPEN ITEM #6) -- if we later LIFT `recap/shared/`
 *      to a neutral `src/broker/llm-engine/`, only this seam file changes, not
 *      every SOTU call site.
 *   2. It documents the read-only boundary: SOTU imports these, never mutates
 *      them, never adds to recap's modules.
 *
 * NOT re-exported: recap's private `runLlmCall` (period/orchestrator.ts) -- it is
 * welded to recap's bundle/deps/recapId. SOTU's Phase 4 writes its OWN thin
 * wrapper composing `chat()` + a `RecapLedger` + the SOTU distill bundle,
 * modeled on recap's, not importing the private function.
 *
 * The seam grows with its consumers: Phase 0 re-exports the primitives the
 * store needs + a guarded smoke surface; Phase 4 extends it (ChatRequest, the
 * typed OpenRouter errors, NormalizedUsage, ...) when the distill wrapper that
 * consumes them lands. Re-exporting a wide forward API before any consumer just
 * trips the dead-code gate -- so each symbol arrives with its caller.
 */

// ─── Cost ledger (COST 2 -- per-call token/USD/cache trail) ─────────
export { RECAP_LEDGER_VERSION, RecapLedger } from '../recap/period/ledger'
// ─── JSON salvage (responseFormat:json_object output parsing) ────────
export { findFirstJsonObject } from '../recap/shared/json-parse'
// ─── OpenRouter client (the chat() round-trip) ──────────────────────
export { chat } from '../recap/shared/openrouter-client'
// ─── Pricing / usage normalization (COST 2 inputs) ──────────────────
export { computeCostUsd, normalizeUsage } from '../recap/shared/pricing'
