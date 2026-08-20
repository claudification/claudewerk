/**
 * FNV-1a, 32-bit. Stable across runtimes and tiny.
 *
 * Lives on its own because two callers now need the same bytes for two very
 * different reasons -- an epic's colour must not change because the panel was
 * rebuilt, and a truncated worktree branch must not change because the broker
 * was. Both want "same input, same number, forever"; neither wants a dependency
 * on the other's module.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** The hash as fixed-width lowercase hex -- a discriminator you can paste into
 *  a branch name without it changing length between inputs. */
export function fnv1aHex(input: string): string {
  return fnv1a(input).toString(16).padStart(8, '0')
}
