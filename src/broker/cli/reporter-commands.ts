/**
 * `broker-cli reporter ...` -- the ONLY creation path for an `rpt_` key.
 *
 * Deliberately CLI-only. There is no `/api/reporters/create` route, because a
 * credential-minting route is reachable from a browser and a reporter key is
 * supposed to be the thing you can hand out freely; the two properties do not
 * belong on the same surface. Minting happens where the registry file lives.
 */

import { createSentinelRegistry, isValidSentinelAlias, type SentinelRegistry } from '../sentinel-registry'
import type { ParsedArgs } from './parse-args'
import { notifyServer } from './shared'

function handleCreate(args: ParsedArgs, registry: SentinelRegistry): void {
  if (!args.aliasArg) {
    console.error('ERROR: --alias is required')
    process.exit(1)
  }
  const alias = args.aliasArg.trim().toLowerCase()
  if (!isValidSentinelAlias(alias)) {
    console.error('ERROR: Invalid alias (lowercase alphanumeric + hyphens, 1-63 chars)')
    process.exit(1)
  }
  // Uniqueness across BOTH kinds -- a reporter must not shadow a sentinel name.
  if (registry.findAnyByAlias(alias)) {
    console.error(`ERROR: Alias "${alias}" already exists`)
    process.exit(1)
  }

  const record = registry.create({ alias, color: args.colorArg || undefined, generateSecret: true, kind: 'reporter' })
  console.log(`
  REPORTER CREATED

  ID:     ${record.sentinelId}
  Alias:  ${record.aliases[0]}
  Secret: ${record.rawSecret}

  This key can do EXACTLY ONE thing: report node stats over a WebSocket.
  It authenticates no HTTP route, it holds one connection at a time, and it
  can never be picked as a spawn target.

  Run the reporter on the target machine:
    node-stats-reporter --broker wss://<your-broker-host> --secret ${record.rawSecret}

  Or via env:
    export CLAUDWERK_REPORTER_SECRET=${record.rawSecret}
    export CLAUDWERK_BROKER=wss://<your-broker-host>
    node-stats-reporter
`)
  notifyServer(args.cacheDir)
}

function handleList(registry: SentinelRegistry): void {
  const all = registry.getAllReporters()
  if (all.size === 0) {
    console.log('No registered reporters.')
    return
  }
  console.log(`\n  Reporters (${all.size}):`)
  for (const [id, record] of all) {
    const color = record.color ? ` color=${record.color}` : ''
    console.log(`  ${record.aliases[0]} (${id.slice(0, 8)}...)${color}`)
    console.log(`    created: ${new Date(record.createdAt).toLocaleString()}`)
  }
  console.log()
}

function handleRevoke(args: ParsedArgs, registry: SentinelRegistry): void {
  if (!args.aliasArg) {
    console.error('ERROR: --alias is required')
    process.exit(1)
  }
  // Scoped to reporters so `reporter revoke --alias beast` can never delete the
  // SENTINEL called beast.
  const found = registry.findReporterByAlias(args.aliasArg)
  if (!found) {
    console.error(`ERROR: Reporter "${args.aliasArg}" not found`)
    process.exit(1)
  }
  registry.remove(found.sentinelId)
  console.log(`Reporter "${args.aliasArg}" revoked. Secret invalidated.`)
  notifyServer(args.cacheDir)
}

export function handleReporter(args: ParsedArgs): void {
  const registry = createSentinelRegistry(args.cacheDir)

  switch (args.subCommand) {
    case 'create':
      handleCreate(args, registry)
      break
    case 'list':
      handleList(registry)
      break
    case 'revoke':
      handleRevoke(args, registry)
      break
    default:
      console.error(`Unknown reporter subcommand: ${args.subCommand || '(none)'}`)
      console.error('Available: create, list, revoke')
      process.exit(1)
  }
}
