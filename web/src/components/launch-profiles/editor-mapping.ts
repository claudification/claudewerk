import type { LaunchProfile } from '@shared/launch-profile'
import type { LaunchFieldsValue } from '@/components/launch-config-fields'

export function launchFieldsFromProfile(p: LaunchProfile): LaunchFieldsValue {
  return {
    model: p.spawn.model ?? '',
    effort: p.spawn.effort ?? '',
    permissionMode: p.spawn.permissionMode ?? '',
    agent: p.spawn.agent ?? '',
    advisor: p.spawn.advisor ?? undefined,
    autocompactPct: p.spawn.autocompactPct ?? '',
    maxBudgetUsd: p.spawn.maxBudgetUsd != null ? String(p.spawn.maxBudgetUsd) : '',
    headless: p.spawn.headless ?? true,
    bare: p.spawn.bare ?? false,
    repl: p.spawn.repl ?? false,
    thinkingSummaries: p.spawn.thinkingSummaries ?? true,
    includePartialMessages: p.spawn.includePartialMessages ?? true,
  }
}

export function spawnPatchFromLaunchFields(patch: Partial<LaunchFieldsValue>): Partial<LaunchProfile['spawn']> {
  const out: Partial<LaunchProfile['spawn']> = {}
  // Plain string fields: copy through, empty string -> undefined (clears it).
  for (const key of ['model', 'effort', 'permissionMode', 'agent', 'advisor'] as const) {
    if (patch[key] !== undefined) (out as Record<string, unknown>)[key] = patch[key] || undefined
  }
  if (patch.autocompactPct !== undefined) {
    out.autocompactPct = patch.autocompactPct === '' ? undefined : Number(patch.autocompactPct)
  }
  if (patch.maxBudgetUsd !== undefined) {
    const n = Number(patch.maxBudgetUsd)
    out.maxBudgetUsd = Number.isFinite(n) && n > 0 ? n : undefined
  }
  if (patch.headless !== undefined) out.headless = patch.headless
  if (patch.bare !== undefined) out.bare = patch.bare || undefined
  if (patch.repl !== undefined) out.repl = patch.repl || undefined
  // Stored only when OFF: on is the resolver default, so an absent field means
  // "inherit", and a profile does not pin a value the user never changed.
  if (patch.thinkingSummaries !== undefined) out.thinkingSummaries = patch.thinkingSummaries ? undefined : false
  if (patch.includePartialMessages !== undefined) out.includePartialMessages = patch.includePartialMessages
  return out
}
