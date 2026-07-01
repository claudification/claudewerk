/**
 * Single source of truth for the models rclaude surfaces to the user.
 *
 * Consumers:
 * - Spawn/Run dropdown (`MODEL_OPTIONS`) in `src/shared/spawn-schema.ts`.
 * - `/model <id>` autocomplete (`KNOWN_MODEL_IDS`) in
 *   `web/src/components/input-editor/autocomplete-shared.ts`.
 * - Spawn request validation (`modelEnum`) in `src/shared/spawn-schema.ts`.
 * - Early model validation (`validateModel`) in `src/shared/spawn-defaults.ts`.
 *
 * THE registry: `CC_MODELS` below is the single source of truth for model
 * capabilities (token limits, 1M behavior, tier, accepted slugs). Everything
 * else derives from it -- the UI catalog, the spawn-dropdown grouping
 * (`spawn-schema.ts`), and the runtime context-window resolver
 * (`context-window.ts`). Adding a model = ONE new object in `CC_MODELS`.
 *
 * Model data extracted from the CC v2.1.197 binary (2026-07-01) for the
 * `claude-sonnet-5` family (default `sonnet` alias now resolves here);
 * `claude-fable-5` / `claude-mythos-5` / `claude-opus-4-8` from the v2.1.170
 * cut (2026-06-10); older entries reflect earlier extractions. When a new CC
 * version ships, re-extract:
 *   strings $(readlink -f $(which claude)) | grep -oE \
 *     'key:value' patterns (see extraction notes in docs/ops.md)
 * and add/update the family in `CC_MODELS` below.
 */

export type ContextWindow = 200_000 | 1_000_000

export interface ModelEntry {
  /** Value passed verbatim to CC as `--model <id>` or `/model <id>`. */
  id: string
  /** Human-facing label shown in the spawn/run dropdown. */
  label: string
  /** One-line hint shown as the dropdown subtitle. */
  info: string
  /** Resolved context window in tokens. Matches `resolveContextWindow(id)`. */
  window: ContextWindow
  /** Whether the option appears in the spawn/run model dropdown. */
  showInDropdown: boolean
  /** Whether the id autocompletes for `/model <id>` inside a conversation. */
  showInCompleter: boolean
}

// ─── CC model registry (extracted from binary) ────────────────────
//
// CC normalizes every input slug to a "family ID" (e.g. claude-opus-4-7).
// The family ID determines capabilities and token limits.
//
// Source: CC v2.1.116 function `Ba()` (output token limits) and
// provider-id maps (firstParty/bedrock/vertex/foundry/anthropicAws).

export interface CCModelFamily {
  /** Normalized family ID that CC resolves to internally. */
  familyId: string
  /** Human-facing display name (from CC's switch/case). */
  displayName: string
  /** Default output token limit. */
  defaultOutputTokens: number
  /** Maximum output token limit (upper bound). */
  maxOutputTokens: number
  /** Whether this model supports 1M context (via [1m] suffix or by default). */
  supports1M: boolean
  /** Whether 1M is the default (no suffix needed). Opus 4.7+ and Fable/Mythos 5. */
  default1M: boolean
  /** Generation bucket -- drives the spawn-dropdown grouping (no id regexes). */
  tier: ModelTier
  /** All input slugs CC accepts that resolve to this family. */
  acceptedSlugs: string[]
  /**
   * Static list price (USD per million tokens) used ONLY as a fallback when
   * LiteLLM has not yet published this model -- e.g. a model released today.
   * The live LiteLLM value always wins once it lands. Set for brand-new models.
   */
  fallbackPriceUsdPerMTok?: { input: number; output: number }
}

export type ModelTier = 'current' | 'previous' | 'legacy'

/**
 * Every model family CC v2.1.197 recognizes, with token limits extracted
 * from the binary. Ordered newest-first within each tier.
 */
const CC_MODELS: readonly CCModelFamily[] = [
  // ── Current models ──────────────────────────────────────────────
  {
    familyId: 'claude-fable-5',
    displayName: 'Fable 5',
    defaultOutputTokens: 64_000,
    maxOutputTokens: 128_000,
    supports1M: true,
    // CC's `KJ_()` strips a trailing [1m] then matches the bare id -- 1M is the
    // default, suffix optional (like Opus 4.7+). The `fable` bare alias resolves
    // here (i8_={...fable5:claude-fable-5}); `fable[1m]` is the explicit form.
    default1M: true,
    tier: 'current',
    acceptedSlugs: ['claude-fable-5', 'claude-fable-5[1m]', 'fable', 'fable[1m]'],
    // Anthropic launch pricing (2026-06-10). Fallback until LiteLLM publishes it.
    fallbackPriceUsdPerMTok: { input: 10, output: 50 },
  },
  {
    familyId: 'claude-mythos-5',
    displayName: 'Mythos 5',
    defaultOutputTokens: 64_000,
    maxOutputTokens: 128_000,
    supports1M: true,
    // `OJ_()` mirrors `KJ_()` for mythos -- also default-1M. Mythos is the
    // underlying class label; Fable 5 is the GA product name. Same token limits.
    default1M: true,
    tier: 'current',
    acceptedSlugs: ['claude-mythos-5', 'claude-mythos-preview'],
    // Same Mythos-class pricing as Fable 5.
    fallbackPriceUsdPerMTok: { input: 10, output: 50 },
  },
  {
    familyId: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    defaultOutputTokens: 64_000,
    maxOutputTokens: 128_000,
    supports1M: true,
    default1M: true,
    tier: 'current',
    // CC v2.1.170 maps the bare `opus` alias to this family
    // (i8_={opus:"claude-opus-4-8",...} in the binary). `opus[1m]` is a valid
    // bare alias in CC's alias array ($NH) -- include it so it validates + resolves.
    acceptedSlugs: ['claude-opus-4-8', 'claude-opus-4-8[1m]', 'opus', 'opus[1m]'],
  },
  {
    familyId: 'claude-opus-4-7',
    displayName: 'Opus 4.7',
    defaultOutputTokens: 64_000,
    maxOutputTokens: 128_000,
    supports1M: true,
    default1M: true,
    tier: 'current',
    acceptedSlugs: ['claude-opus-4-7', 'claude-opus-4-7[1m]'],
  },
  {
    familyId: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    defaultOutputTokens: 64_000,
    maxOutputTokens: 128_000,
    supports1M: true,
    default1M: false,
    tier: 'current',
    acceptedSlugs: ['claude-opus-4-6', 'claude-opus-4-6[1m]', 'claude-opus-4-6-20251101', 'claude-opus-4-6-fast'],
  },
  {
    familyId: 'claude-sonnet-5',
    displayName: 'Sonnet 5',
    // Binary switch (2.1.197): claude-sonnet-5 -> t=64000, n=128000 -- richer
    // default output than the 4.x sonnets (32K).
    defaultOutputTokens: 64_000,
    maxOutputTokens: 128_000,
    supports1M: true,
    // In CC's default-[1m] alias set: bare `sonnet` -> claude-sonnet-5 at 1M with
    // NO [1m] suffix (like opus-4-7/4-8/fable/mythos). First Sonnet where 1M is the
    // default rather than opt-in -- the [1m] variants below are now redundant.
    default1M: true,
    tier: 'current',
    // CC v2.1.197 remaps the bare `sonnet` alias to this family
    // (i8_={...sonnet:"claude-sonnet-5",...}); moved here off claude-sonnet-4-6.
    acceptedSlugs: ['claude-sonnet-5', 'claude-sonnet-5[1m]', 'sonnet', 'sonnet[1m]'],
    // Anthropic list price from the binary's pricing table (2.1.197): $3/$15
    // ($2/$10 intro through 2026-08-31). Fallback until LiteLLM publishes it.
    fallbackPriceUsdPerMTok: { input: 3, output: 15 },
  },
  {
    familyId: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 128_000,
    supports1M: true,
    default1M: false,
    tier: 'current',
    // Bare `sonnet`/`sonnet[1m]` moved to claude-sonnet-5 (CC now resolves them
    // there). 4.6 keeps only its qualified slugs.
    acceptedSlugs: ['claude-sonnet-4-6', 'claude-sonnet-4-6[1m]'],
  },
  {
    familyId: 'claude-haiku-4-5',
    displayName: 'Haiku 4.5',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 64_000,
    supports1M: false,
    default1M: false,
    tier: 'current',
    acceptedSlugs: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'haiku'],
  },

  // ── Previous generation (still accepted by CC) ──────────────────
  {
    familyId: 'claude-opus-4-5',
    displayName: 'Opus 4.5',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 64_000,
    supports1M: false,
    default1M: false,
    tier: 'previous',
    acceptedSlugs: ['claude-opus-4-5', 'claude-opus-4-5-20251101'],
  },
  {
    familyId: 'claude-sonnet-4-5',
    displayName: 'Sonnet 4.5',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 64_000,
    supports1M: true,
    default1M: false,
    tier: 'previous',
    acceptedSlugs: ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929[1m]'],
  },
  {
    familyId: 'claude-sonnet-4-0',
    displayName: 'Sonnet 4',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 64_000,
    supports1M: false,
    default1M: false,
    tier: 'previous',
    acceptedSlugs: ['claude-sonnet-4-0', 'claude-sonnet-4-20250514'],
  },
  {
    familyId: 'claude-opus-4-1',
    displayName: 'Opus 4.1',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 32_000,
    supports1M: false,
    default1M: false,
    tier: 'previous',
    acceptedSlugs: ['claude-opus-4-1', 'claude-opus-4-1-20250805'],
  },
  {
    familyId: 'claude-opus-4-0',
    displayName: 'Opus 4',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 32_000,
    supports1M: false,
    default1M: false,
    tier: 'previous',
    acceptedSlugs: ['claude-opus-4-0', 'claude-opus-4-20250514'],
  },

  // ── Legacy (3.x family) ─────────────────────────────────────────
  {
    familyId: 'claude-3-7-sonnet',
    displayName: 'Sonnet 3.7',
    defaultOutputTokens: 32_000,
    maxOutputTokens: 64_000,
    supports1M: false,
    default1M: false,
    tier: 'legacy',
    acceptedSlugs: ['claude-3-7-sonnet', 'claude-3-7-sonnet-20250219'],
  },
  {
    familyId: 'claude-3-5-sonnet',
    displayName: 'Sonnet 3.5',
    defaultOutputTokens: 8_192,
    maxOutputTokens: 8_192,
    supports1M: false,
    default1M: false,
    tier: 'legacy',
    acceptedSlugs: ['claude-3-5-sonnet', 'claude-3-5-sonnet-20241022'],
  },
  {
    familyId: 'claude-3-5-haiku',
    displayName: 'Haiku 3.5',
    defaultOutputTokens: 8_192,
    maxOutputTokens: 8_192,
    supports1M: false,
    default1M: false,
    tier: 'legacy',
    acceptedSlugs: ['claude-3-5-haiku', 'claude-3-5-haiku-20241022'],
  },
] as const

/**
 * Dynamic meta-aliases CC accepts that do NOT map to a single family -- they
 * resolve at runtime. `best` picks the strongest available model (Fable today);
 * `opusplan` runs Opus while planning and Sonnet otherwise. We accept them for
 * validation but cannot attach a family/context-window to them.
 */
const DYNAMIC_ALIASES: readonly string[] = ['best', 'opusplan']

/**
 * Claudewerk-only convenience aliases that CC does NOT accept as input. CC's
 * bare-alias map is exactly `{fable, opus, sonnet, haiku}` -- `mythos` only
 * appears in a cosmetic codename list there, so `--model mythos` falls through
 * to a generic `claude` (wrong model). We let users type the short `mythos`
 * mnemonic and expand it to the Mythos family's full slug via
 * `canonicalizeModelSlug` at EVERY point a slug is handed to CC (spawn resolve,
 * runtime /model change). Keys are matched case-insensitively.
 */
const CLAUDWERK_MODEL_ALIASES: Readonly<Record<string, string>> = {
  mythos: 'claude-mythos-5',
}

/**
 * Expand a claudewerk-only alias (e.g. `mythos`) to a CC-resolvable slug.
 * Idempotent; anything that isn't a known alias passes through unchanged. MUST
 * be applied wherever a model slug crosses into CC, since CC won't resolve our
 * aliases itself. `undefined` passes through (callers thread optional models).
 */
export function canonicalizeModelSlug(slug: string): string
export function canonicalizeModelSlug(slug: string | undefined): string | undefined
export function canonicalizeModelSlug(slug: string | undefined): string | undefined {
  if (!slug) return slug
  return CLAUDWERK_MODEL_ALIASES[slug.toLowerCase()] ?? slug
}

/**
 * Every slug rclaude accepts as a flat array -- drives zod schema validation.
 * Includes the claudewerk-only alias keys so `mythos` validates; they expand to
 * a CC slug via `canonicalizeModelSlug` before reaching CC.
 */
export const ALL_CC_SLUGS: readonly string[] = [
  ...CC_MODELS.flatMap(m => m.acceptedSlugs),
  ...DYNAMIC_ALIASES,
  ...Object.keys(CLAUDWERK_MODEL_ALIASES),
]

/** Set of every slug CC accepts -- for fast lookup. */
const ALL_ACCEPTED_SLUGS: ReadonlySet<string> = new Set(ALL_CC_SLUGS)

/**
 * Find the model family for a given slug (case-insensitive, strips [1m]).
 * Expands claudewerk-only aliases first so `mythos` resolves to the Mythos
 * family (and thus its context window / pricing).
 */
export function resolveModelFamily(slug: string): CCModelFamily | undefined {
  const lower = canonicalizeModelSlug(slug).toLowerCase()
  return CC_MODELS.find(m => m.acceptedSlugs.some(s => s.toLowerCase() === lower))
}

/**
 * Whether a slug resolves to a model whose 1M context window is the DEFAULT
 * (no `[1m]` suffix needed). Registry-driven -- the SINGLE place this is decided.
 * Handles exact slugs, the `[1m]`/`-1m` suffix, bare aliases, and forward
 * date-pinned/variant slugs (e.g. `claude-fable-5-20260610`) via family prefix.
 * `context-window.ts` calls this instead of carrying its own model regex.
 */
export function isDefault1MFamily(slug: string): boolean {
  const bare = slug.toLowerCase().replace(/(\[1m\]|-1m)$/i, '')
  const exact = resolveModelFamily(bare)
  if (exact) return exact.default1M
  return CC_MODELS.some(m => m.default1M && bare.startsWith(m.familyId))
}

/**
 * Score a model name by specificity. Higher = more informative.
 *
 *   "opus"                  -> 1  (bare alias)
 *   "claude-opus-4-7"       -> 3  (qualified family ID)
 *   "claude-opus-4-6-fast"  -> 4  (qualified + variant)
 *   "claude-opus-4-7[1m]"   -> 4  (qualified + context window)
 *   "claude-opus-4-5-20251101"      -> 4  (qualified + date pin)
 *   "claude-opus-4-6-20251101[1m]"  -> 5  (qualified + date + context)
 */
function modelSpecificity(name: string): number {
  if (!name) return 0
  let score = 0
  // Qualified ID (has version numbers like X-Y or X-Y-Z)
  if (/claude-\w+-\d+-\d/.test(name)) score += 3
  // Bare alias ("opus", "sonnet", "haiku") -- recognized but lossy
  else if (resolveModelFamily(name)) score += 1
  // Unknown string -- still better than nothing
  else score += 2
  // Context window suffix [1m] / [200k]
  if (/\[\d+[km]?\]/.test(name)) score += 1
  // Date pin (-20251001)
  if (/-\d{8}/.test(name)) score += 1
  // Variant suffix (-fast)
  if (/-fast\b/.test(name)) score += 1
  return score
}

/**
 * Given two model names, return the most informative one.
 * Init message is ground truth -- pass it as `a` (preferred on tie).
 * Falls back to `b` (typically --model flag) only when it's strictly
 * more specific (e.g. preserves [1m] suffix that init stripped).
 */
export function deriveModelName(a: string | undefined, b: string | undefined): string | undefined {
  if (!a && !b) return undefined
  if (!a) return b
  if (!b) return a
  const scoreA = modelSpecificity(a)
  const scoreB = modelSpecificity(b)
  // a wins ties -- it's the init/ground-truth value
  return scoreB > scoreA ? b : a
}

export interface ModelValidationResult {
  valid: boolean
  family?: CCModelFamily
  warning?: string
}

/**
 * Validate a model slug against CC's known model registry.
 *
 * Returns { valid: true, family } for recognized slugs.
 * Returns { valid: false, warning } for unknown slugs with a list of valid models.
 */
export function validateModel(slug: string): ModelValidationResult {
  const lower = slug.toLowerCase()

  if (ALL_ACCEPTED_SLUGS.has(slug) || ALL_ACCEPTED_SLUGS.has(lower)) {
    const family = resolveModelFamily(slug)
    return { valid: true, family: family || undefined }
  }

  // Provider-specific IDs (Bedrock, Vertex, Foundry) -- we don't validate these
  if (/^us\.anthropic\./.test(lower) || /@\d{8}$/.test(lower) || /^anthropic\./.test(lower)) {
    return { valid: true }
  }

  return { valid: false, warning: formatModelError(slug) }
}

function formatModelError(slug: string): string {
  const lines = [`Unknown model "${slug}". Valid models (CC v2.1.197):`, '']
  const current = CC_MODELS.filter(m => !m.familyId.startsWith('claude-3-'))
  const legacy = CC_MODELS.filter(m => m.familyId.startsWith('claude-3-'))

  for (const m of current) {
    const ctx = m.default1M ? '1M default' : m.supports1M ? '200K (1M via [1m])' : '200K'
    const out = `${(m.maxOutputTokens / 1000).toFixed(0)}K output`
    const slugs = m.acceptedSlugs.join(', ')
    lines.push(`  ${m.displayName.padEnd(12)} ${ctx.padEnd(20)} ${out.padEnd(12)} [${slugs}]`)
  }

  if (legacy.length > 0) {
    lines.push('')
    lines.push(`  Legacy: ${legacy.map(m => m.familyId).join(', ')}`)
  }

  lines.push('')
  lines.push('  Aliases: opus, sonnet, haiku, fable, mythos, best, opusplan')
  return lines.join('\n')
}

// ─── UI-facing exports (unchanged interface) ──────────────────────
//
// MODEL_CATALOG drives the spawn dropdown, /model autocomplete, and
// zod validation. It's a curated subset of CC_MODELS -- not every
// accepted slug needs a dropdown entry.

/**
 * Authoritative model catalog for UI. Ordered the way they appear in the dropdown.
 *
 * The "latest" rows USE CC's bare aliases (`fable`, `opus`, `sonnet`, `haiku`) so
 * they auto-track Anthropic's newest build with no maintenance -- no more "bump the
 * pinned id" when a new model ships. Safe because the agent host upgrades a stored
 * alias to the resolved family id at runtime (`deriveModelName`), and default-1M
 * families (fable/opus/sonnet-5) stay 1M either way.
 */
const MODEL_CATALOG: readonly ModelEntry[] = [
  // --- Shorthand defaults: ONE bare-alias row per family (auto-track latest) ---
  // These USE CC's bare aliases (`fable`, `opus`, `sonnet`, `haiku`) so they
  // always resolve to Anthropic's newest build for that family with zero
  // maintenance -- no pinned-id bumping. The pinned specifics (Opus 4.8, 4.7,
  // ...) follow further down for anyone who wants to lock a version.
  {
    // Bare `fable` alias -> claude-fable-5 (1M default). Flagship.
    id: 'fable',
    label: 'Fable (latest)',
    info: 'Fable 5 · 1M default · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    // Bare `opus` alias -> claude-opus-4-8. Default-1M family, so no [1m] needed.
    id: 'opus',
    label: 'Opus (latest)',
    info: 'Opus 4.8 · 1M default · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    // Bare `sonnet` alias -> claude-sonnet-5. Default-1M family, so no [1m] needed.
    id: 'sonnet',
    label: 'Sonnet (latest)',
    info: 'Sonnet 5 · 1M default · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    // Bare `haiku` alias -> latest Haiku (200K).
    id: 'haiku',
    label: 'Haiku (latest)',
    info: 'Haiku 4.5 · 200K · 64K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },

  // --- Flagship specific ---
  {
    // Mythos is the underlying class label for Fable 5 -- same limits. The bare
    // `mythos` mnemonic (typeable) maps here via canonicalizeModelSlug since CC
    // won't resolve bare `mythos` on its own.
    id: 'claude-mythos-5',
    label: 'Mythos 5',
    info: 'Mythos 5 · 1M default · 128K output (class label for Fable 5)',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },

  // --- Completer-only explicit-1M variants (not in the dropdown) ---
  {
    // Redundant with the bare `opus` default (already default-1M) but kept
    // typeable via `/model` for users who spell out the suffix.
    id: 'opus[1m]',
    label: 'Opus (latest, 1M)',
    info: 'Opus 4.8 · 1M · 128K output',
    window: 1_000_000,
    showInDropdown: false,
    showInCompleter: true,
  },
  {
    // Redundant with the bare `sonnet` default (already default-1M) but kept
    // typeable via `/model` for users who spell out the suffix. Pinned to the
    // qualified slug: `deriveModelName` would drop a bare `sonnet[1m]` to an alias.
    id: 'claude-sonnet-5[1m]',
    label: 'Sonnet (latest, 1M)',
    info: 'Sonnet 5 · 1M · 128K output',
    window: 1_000_000,
    showInDropdown: false,
    showInCompleter: true,
  },

  // --- Explicit pinned versions ---
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    info: 'Pinned · 1M default · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    info: 'Pinned · 1M default · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-6[1m]',
    label: 'Opus 4.6 (1M)',
    info: 'Pinned · 1M · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    info: 'Pinned · 200K · 128K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    info: 'Pinned · 1M default · 128K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    info: 'Pinned · 200K · 128K output',
    window: 200_000,
    showInDropdown: false,
    showInCompleter: true,
  },

  // --- Previous generation ---
  {
    id: 'claude-opus-4-5',
    label: 'Opus 4.5',
    info: '200K · 64K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
    info: '200K (1M via [1m]) · 64K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-5-20250929[1m]',
    label: 'Sonnet 4.5 (1M)',
    info: '1M context · 64K output',
    window: 1_000_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-sonnet-4-0',
    label: 'Sonnet 4',
    info: '200K · 64K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-1',
    label: 'Opus 4.1',
    info: '200K · 32K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-opus-4-0',
    label: 'Opus 4',
    info: '200K · 32K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },

  // --- Legacy (3.x) ---
  {
    id: 'claude-3-7-sonnet',
    label: 'Sonnet 3.7',
    info: '200K · 64K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-3-5-sonnet',
    label: 'Sonnet 3.5',
    info: '200K · 8K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },
  {
    id: 'claude-3-5-haiku',
    label: 'Haiku 3.5',
    info: '200K · 8K output',
    window: 200_000,
    showInDropdown: true,
    showInCompleter: true,
  },

  // --- Meta-aliases (typeable, not in the dropdown) ---
  // The bare family shorthands (`fable`, `opus`, `sonnet`, `haiku`) are the
  // shorthand-default rows at the TOP of this catalog -- not repeated here.
  {
    id: 'best',
    label: 'best',
    info: 'CC alias -> strongest available model (Fable today)',
    window: 1_000_000,
    showInDropdown: false,
    showInCompleter: true,
  },
  {
    id: 'opusplan',
    label: 'opusplan',
    info: 'CC alias -> Opus while planning, else Sonnet',
    window: 1_000_000,
    showInDropdown: false,
    showInCompleter: true,
  },
] as const

/** Every id known to rclaude -- drives `modelEnum` validation. */
const _KNOWN_MODEL_IDS: readonly string[] = MODEL_CATALOG.map(m => m.id)

/** Ids surfaced in the `/model` autocomplete list (preserves catalog order). */
export const COMPLETER_MODEL_IDS: readonly string[] = MODEL_CATALOG.filter(m => m.showInCompleter).map(m => m.id)

/** Dropdown rows for Spawn/Run -- consumed by LaunchConfigFields. */
export const DROPDOWN_MODEL_ENTRIES: readonly Pick<ModelEntry, 'id' | 'label' | 'info'>[] = MODEL_CATALOG.filter(
  m => m.showInDropdown,
).map(m => ({ id: m.id, label: m.label, info: m.info }))
