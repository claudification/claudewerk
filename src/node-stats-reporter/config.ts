/**
 * node-stats-reporter configuration. Flags beat env; there are no defaults for
 * the two things that matter (broker + secret), because a reporter that guesses
 * where to connect is a reporter pointed at the wrong fleet.
 */

export interface ReporterConfig {
  brokerUrl: string
  secret: string
  /** Volume to measure. Defaults to cwd -- the disk that, when full, kills us. */
  diskMount?: string
  verbose: boolean
}

export interface ParseResult {
  ok: boolean
  config?: ReporterConfig
  error?: string
}

const USAGE = `node-stats-reporter -- report this machine's vitals to a CLAUDEWERK broker.

  --broker <url>     Broker WebSocket URL      (env CLAUDWERK_BROKER)
  --secret <rpt_...> Reporter key              (env CLAUDWERK_REPORTER_SECRET)
  --disk <path>      Volume to measure         (default: cwd)
  --verbose          Log every sample
  -h, --help         This text

Mint a key on the broker host:  broker-cli reporter create --alias <name>

This binary reports vitals and does nothing else. It cannot spawn, it holds no
credential store, and its key authenticates no HTTP route.`

export function usage(): string {
  return USAGE
}

export function parseReporterArgs(argv: string[], env: NodeJS.ProcessEnv): ParseResult {
  let brokerUrl = env.CLAUDWERK_BROKER || ''
  let secret = env.CLAUDWERK_REPORTER_SECRET || ''
  let diskMount: string | undefined
  let verbose = false

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--broker':
        brokerUrl = argv[++i] ?? ''
        break
      case '--secret':
        secret = argv[++i] ?? ''
        break
      case '--disk':
        diskMount = argv[++i]
        break
      case '--verbose':
        verbose = true
        break
      case '-h':
      case '--help':
        return { ok: false, error: USAGE }
      default:
        if (argv[i].startsWith('-')) return { ok: false, error: `Unknown flag: ${argv[i]}\n\n${USAGE}` }
    }
  }

  if (!brokerUrl) return { ok: false, error: `Missing --broker (or CLAUDWERK_BROKER)\n\n${USAGE}` }
  if (!secret) return { ok: false, error: `Missing --secret (or CLAUDWERK_REPORTER_SECRET)\n\n${USAGE}` }
  if (!secret.startsWith('rpt_')) {
    // Fail loudly rather than dialling with an `snt_`: a reporter must not be
    // run with spawn-capable credentials by accident.
    return {
      ok: false,
      error: 'Secret must be a reporter key (rpt_ prefix). Refusing to run with any other credential.',
    }
  }

  return { ok: true, config: { brokerUrl, secret, diskMount, verbose } }
}

/** Reconnect backoff: quick at first, capped, so a rejected key does not spin. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
}
