import type { ParsedArgs } from './parse-args'

export type SubcommandHandler = (args: ParsedArgs) => void | Promise<void>
export type SubcommandMap = Record<string, SubcommandHandler>

/** Route `args.subCommand` through a strategy map, failing with the available
 *  set rather than a bare "unknown". Shared so every command group reports the
 *  same way. */
export async function dispatchSubcommand(command: string, map: SubcommandMap, args: ParsedArgs): Promise<void> {
  const handler = map[args.subCommand]
  if (!handler) {
    console.error(`Unknown ${command} subcommand: ${args.subCommand || '(none)'}`)
    console.error(`Available: ${Object.keys(map).join(', ')}`)
    process.exit(1)
  }
  await handler(args)
}

/** Parse a positive-integer flag, exiting with a pointed message rather than
 *  silently falling back (a mistyped --hot-days must not quietly become 90). */
export function positiveIntArg(raw: string, fallback: number, flag: string): number {
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  if (Number.isNaN(n) || n < 1) {
    console.error(`ERROR: ${flag} must be a positive integer`)
    process.exit(1)
  }
  return n
}
