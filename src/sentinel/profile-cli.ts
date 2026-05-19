/**
 * `sentinel profile <subcommand>` -- read/write the sentinel-local
 * `sentinel.json` config file and drive per-profile `claude auth login`.
 *
 * Runs OUTSIDE the broker connection. The sentinel daemon reloads its
 * in-memory config on next start; there is no hot-reload (profiles are
 * static for a sentinel's lifetime, like sentinel-settings.json).
 *
 * Subcommands:
 *   list                                 print configured profiles
 *   add <name> --config-dir <path>       create a profile
 *       [--label <text>] [--color <hex>]
 *       [--spawn-root <path>] [--no-pool]
 *   auth <name>                          run `claude auth login` for a profile
 *   rm <name>                            remove a profile (cannot remove `default`)
 *   pool <name> --on|--off               toggle the `pooled` flag
 *
 * Per the Profile-Env Boundary covenant, NONE of this leaks over the wire --
 * the broker never sees configDir / env. The CLI's job is to edit the
 * sentinel-local JSON file and run `claude auth login` against the right
 * `CLAUDE_CONFIG_DIR`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import {
  DEFAULT_PROFILE_NAME,
  defaultConfigPath,
  loadSentinelConfig,
  profileIsAuthed,
  type SentinelConfigFile,
  type SentinelProfileFile,
} from './sentinel-config'

const PROFILE_NAME_RE = /^[a-z0-9-]{1,63}$/

interface CliOpts {
  configPath?: string
}

type SubcommandHandler = (configPath: string, args: string[]) => number | Promise<number>

const SUBCOMMANDS: Record<string, SubcommandHandler> = {
  list: (cp, _a) => cmdList(cp),
  add: cmdAdd,
  auth: cmdAuth,
  rm: cmdRm,
  remove: cmdRm,
  pool: cmdPool,
}

/**
 * Dispatch a `sentinel profile <subcommand> ...` invocation. Returns the
 * process exit code (0 = success). Tolerates a leading `--config <path>` in
 * `args` so the flag works either before or after the subcommand.
 */
// fallow-ignore-next-line complexity
export async function runProfileCli(args: string[], opts: CliOpts = {}): Promise<number> {
  // Strip an inline `--config <path>` (it may be before or after the subcommand).
  const { rest, configPath: inlineConfigPath } = extractInlineConfig(args)
  const configPath = opts.configPath ?? inlineConfigPath ?? defaultConfigPath()
  const subcommand = rest[0]
  const subArgs = rest.slice(1)

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printHelp()
    return 0
  }
  const handler = SUBCOMMANDS[subcommand]
  if (!handler) {
    process.stderr.write(`Unknown subcommand: ${subcommand}\n`)
    printHelp()
    return 2
  }
  try {
    return await handler(configPath, subArgs)
  } catch (e) {
    process.stderr.write(`sentinel profile ${subcommand}: ${(e as Error).message}\n`)
    return 1
  }
}

function extractInlineConfig(args: string[]): { rest: string[]; configPath?: string } {
  const rest: string[] = []
  let configPath: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      configPath = args[++i]
    } else {
      rest.push(args[i])
    }
  }
  return { rest, configPath }
}

function printHelp(): void {
  process.stdout.write(`sentinel profile -- manage sentinel-local profiles
USAGE:
  sentinel profile [--config <path>] <subcommand> [args]

SUBCOMMANDS:
  list                                       List configured profiles
  add <name> --config-dir <path> [--label <text>] [--color <#hex>]
                                [--spawn-root <path>] [--no-pool]
                                             Add a new profile
  auth <name>                                Run \`claude auth login\` for a profile
  rm <name>                                  Remove a profile (not "default")
  pool <name> --on|--off                     Toggle pooled flag

The config file defaults to ${defaultConfigPath()}.
The implicit "default" profile (${defaultConfigPath().replace(/config\/rclaude\/sentinel\.json$/, '') || '~'}${'/.claude'}) does not need to be listed.
`)
}

// fallow-ignore-next-line complexity
function cmdList(configPath: string): number {
  // loadSentinelConfig validates schema; an absent file yields the implicit
  // `default` profile only, which is the right thing to print.
  const cfg = loadSentinelConfig({ configPath })
  const header = cfg.sourcePath
    ? `config: ${cfg.sourcePath}`
    : `config: ${configPath} (not present -- implicit default profile only)`
  process.stdout.write(`${header}\ndefaultSelection: ${cfg.defaultSelection}\n\nPROFILES\n`)
  const rows: string[][] = [['NAME', 'CONFIG_DIR', 'POOLED', 'AUTHED', 'LABEL']]
  const sorted = Object.values(cfg.profiles).sort((a, b) => a.name.localeCompare(b.name))
  for (const p of sorted) {
    rows.push([
      p.name,
      p.configDir,
      p.pooled ? 'yes' : 'no',
      profileIsAuthed(p.configDir) ? 'yes' : 'no',
      p.label ?? '',
    ])
  }
  process.stdout.write(formatTable(rows))
  return 0
}

function formatTable(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)))
  return (
    rows
      .map(row =>
        row
          .map((c, i) => c.padEnd(widths[i]))
          .join('  ')
          .trimEnd(),
      )
      .join('\n') + '\n'
  )
}

// fallow-ignore-next-line complexity
function cmdAdd(configPath: string, args: string[]): number {
  const nameCheck = validateProfileNameArg(args[0])
  if (nameCheck.code !== 0) return nameCheck.code
  const name = nameCheck.name
  const flags = parseFlags(args.slice(1), {
    string: ['--config-dir', '--label', '--color', '--spawn-root'],
    boolean: ['--no-pool'],
  })
  const configDir = stringFlag(flags, '--config-dir')
  if (!configDir) {
    process.stderr.write('add: --config-dir <path> is required\n')
    return 2
  }
  const file = readRawConfig(configPath)
  const profiles = file.profiles ?? {}
  if (profiles[name]) {
    process.stderr.write(`add: profile "${name}" already exists -- remove it first or edit ${configPath} by hand\n`)
    return 1
  }
  profiles[name] = buildProfileEntry(configDir, flags)
  writeRawConfig(configPath, { ...file, profiles })
  process.stdout.write(`added profile "${name}" -> ${configDir}\n`)
  // Sanity round-trip: re-load so any rejection surfaces immediately.
  loadSentinelConfig({ configPath })
  return 0
}

function validateProfileNameArg(name: string | undefined): { code: number; name: string } {
  if (!name || name.startsWith('-')) {
    process.stderr.write('add: missing profile name (usage: sentinel profile add <name> --config-dir <path> ...)\n')
    return { code: 2, name: '' }
  }
  if (!PROFILE_NAME_RE.test(name)) {
    process.stderr.write(`add: profile name "${name}" must match [a-z0-9-]{1,63}\n`)
    return { code: 2, name: '' }
  }
  return { code: 0, name }
}

// fallow-ignore-next-line complexity
function buildProfileEntry(configDir: string, flags: Record<string, string | true>): SentinelProfileFile {
  const entry: SentinelProfileFile = { configDir }
  const label = stringFlag(flags, '--label')
  const color = stringFlag(flags, '--color')
  const spawnRootArg = stringFlag(flags, '--spawn-root')
  if (label) entry.label = label
  if (color) entry.color = color
  if (spawnRootArg) entry.spawnRoot = spawnRootArg
  if (flags['--no-pool'] === true) entry.pooled = false
  return entry
}

// fallow-ignore-next-line complexity
async function cmdAuth(configPath: string, args: string[]): Promise<number> {
  const name = args[0]
  if (!name) {
    process.stderr.write('auth: missing profile name\n')
    return 2
  }
  const cfg = loadSentinelConfig({ configPath })
  const profile = cfg.profiles[name]
  if (!profile) {
    process.stderr.write(`auth: unknown profile "${name}" (known: ${Object.keys(cfg.profiles).join(', ')})\n`)
    return 1
  }
  // Run `claude auth login` with CLAUDE_CONFIG_DIR pinned to the profile.
  // Interactive: inherit stdio so the user can complete the browser flow.
  const claudeBin = Bun.which('claude') ?? 'claude'
  process.stdout.write(`Running ${claudeBin} auth login with CLAUDE_CONFIG_DIR=${profile.configDir}\n`)
  if (!existsSync(profile.configDir)) mkdirSync(profile.configDir, { recursive: true })
  const code = await runClaudeAuthLogin(claudeBin, profile.configDir, profile.env)
  if (code !== 0) {
    process.stderr.write(`auth: claude auth login exited ${code}\n`)
    return code
  }
  process.stdout.write(`profile "${name}" authed=${profileIsAuthed(profile.configDir)}\n`)
  return 0
}

async function runClaudeAuthLogin(
  claudeBin: string,
  configDir: string,
  profileEnv: Record<string, string>,
): Promise<number> {
  const proc = Bun.spawn([claudeBin, 'auth', 'login'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...profileEnv },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  return code ?? 1
}

// fallow-ignore-next-line complexity
function cmdRm(configPath: string, args: string[]): number {
  const name = args[0]
  if (!name) {
    process.stderr.write('rm: missing profile name\n')
    return 2
  }
  if (name === DEFAULT_PROFILE_NAME) {
    process.stderr.write(`rm: cannot remove the implicit "${DEFAULT_PROFILE_NAME}" profile\n`)
    return 2
  }
  const file = readRawConfig(configPath)
  const profiles = file.profiles ?? {}
  if (!profiles[name]) {
    process.stderr.write(`rm: profile "${name}" not found in ${configPath}\n`)
    return 1
  }
  delete profiles[name]
  writeRawConfig(configPath, { ...file, profiles })
  process.stdout.write(`removed profile "${name}"\n`)
  return 0
}

// fallow-ignore-next-line complexity
function cmdPool(configPath: string, args: string[]): number {
  const parsed = parsePoolArgs(args)
  if (parsed.code !== 0) return parsed.code
  const { name, on } = parsed
  const file = readRawConfig(configPath)
  const profiles = file.profiles ?? {}
  const entry = profiles[name]
  if (!entry) {
    const defaultHint =
      name === DEFAULT_PROFILE_NAME
        ? ' (the implicit default profile is always pooled -- add it explicitly to change)'
        : ''
    process.stderr.write(`pool: profile "${name}" not found in ${configPath}${defaultHint}\n`)
    return 1
  }
  entry.pooled = on
  profiles[name] = entry
  writeRawConfig(configPath, { ...file, profiles })
  process.stdout.write(`profile "${name}" pooled=${entry.pooled}\n`)
  return 0
}

function parsePoolArgs(args: string[]): { code: number; name: string; on: boolean } {
  const name = args[0]
  if (!name) {
    process.stderr.write('pool: missing profile name\n')
    return { code: 2, name: '', on: false }
  }
  const flag = args[1]
  if (flag !== '--on' && flag !== '--off') {
    process.stderr.write('pool: expected --on or --off\n')
    return { code: 2, name: '', on: false }
  }
  return { code: 0, name, on: flag === '--on' }
}

function stringFlag(flags: Record<string, string | true>, name: string): string | undefined {
  const v = flags[name]
  return typeof v === 'string' ? v : undefined
}

// fallow-ignore-next-line complexity
function parseFlags(args: string[], schema: { string: string[]; boolean: string[] }): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (schema.string.includes(arg)) {
      const v = args[++i]
      if (v === undefined) throw new Error(`flag ${arg} requires a value`)
      out[arg] = v
    } else if (schema.boolean.includes(arg)) {
      out[arg] = true
    } else {
      throw new Error(`unknown or misplaced flag: ${arg}`)
    }
  }
  return out
}

function readRawConfig(configPath: string): SentinelConfigFile {
  if (!existsSync(configPath)) return {}
  const text = readFileSync(configPath, 'utf8').trim()
  if (text.length === 0) return {}
  return JSON.parse(text) as SentinelConfigFile
}

function writeRawConfig(configPath: string, file: SentinelConfigFile): void {
  // Ensure parent dir exists -- the user may not have created
  // ~/.config/rclaude/ yet.
  mkdirSync(dirname(configPath), { recursive: true })
  // Stable canonical formatting so a hand-edited file stays diffable.
  const text = `${JSON.stringify(file, null, 2)}\n`
  writeFileSync(configPath, text)
}

// `homedir` is intentionally imported (for future tilde-style sane defaults)
// even though it isn't called yet -- avoids churn the next time a default is
// added. Reference it so the import doesn't trigger an unused-import warning.
void homedir
