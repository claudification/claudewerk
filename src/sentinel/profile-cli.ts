/**
 * `sentinel profile <subcommand>` -- read/write the sentinel-local
 * `sentinel.json` config file and drive per-profile `claude auth login`.
 *
 * Runs OUTSIDE the broker connection. The sentinel daemon reloads its
 * in-memory config on next start; there is no hot-reload (profiles are
 * static for a sentinel's lifetime, like sentinel-settings.json).
 *
 * Subcommands:
 *   list                                       Print configured profiles + pools
 *   add <name> --config-dir <path>             Create a profile
 *       [--label <text>] [--color <hex>]
 *       [--spawn-root <path>]
 *       [--pool <name> | --no-pool]            Pool to join (default: "default";
 *                                              --no-pool excludes from all pools)
 *       [--weight <n>]                         Selection weight (default 1, >= 0;
 *                                              0 = soft drain, never auto-picked)
 *       [--hide-label]                         Suppress the profile's badge
 *                                              in the control panel UI
 *   set <name> [--label <text>] [--color <hex>]   Update display metadata or
 *       [--config-dir <path>]                  filesystem fields on an existing
 *       [--spawn-root <path>]                  profile (use `pool` subcommand
 *       [--weight <n>]                         for pool changes -- it's its own
 *       [--hide-label | --show-label]          verb because pool=null is a real
 *                                              value that flag parsing can't
 *                                              distinguish from "unchanged")
 *   auth <name>                                Run `claude auth login` for a profile
 *   rm <name>                                  Remove a profile (cannot remove "default")
 *   pool <name> --set <pool> | --none          Move a profile to a different pool
 *                                              (or remove it from every pool)
 *
 * Per the Profile-Env Boundary covenant, NONE of this leaks over the wire --
 * the broker never sees configDir / env. The CLI's job is to edit the
 * sentinel-local JSON file and run `claude auth login` against the right
 * `CLAUDE_CONFIG_DIR`.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { writeSecureFileSync } from '../shared/secure-temp'
import {
  DEFAULT_POOL_NAME,
  DEFAULT_PROFILE_NAME,
  defaultConfigPath,
  getPools,
  loadSentinelConfig,
  profileIsAuthed,
  type SentinelConfigFile,
  type SentinelProfileFile,
} from './sentinel-config'

const PROFILE_NAME_RE = /^[a-z0-9-]{1,63}$/
const POOL_NAME_RE = /^[a-z0-9-]{1,63}$/

interface CliOpts {
  configPath?: string
}

type SubcommandHandler = (configPath: string, args: string[]) => number | Promise<number>

const SUBCOMMANDS: Record<string, SubcommandHandler> = {
  list: (cp, _a) => cmdList(cp),
  add: cmdAdd,
  set: cmdSet,
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
  list                                       List configured profiles + pools
  add <name> --config-dir <path>             Add a new profile
      [--label <text>] [--color <#hex>]
      [--spawn-root <path>]
      [--pool <name> | --no-pool]            Pool to join (default: "default");
                                              --no-pool excludes from every pool
      [--weight <n>]                         Selection weight (default 1, >= 0;
                                              0 = soft drain, never auto-picked)
  set <name> [--weight <n>] [...]            Update weight/label/color/etc.
  auth <name>                                Run \`claude auth login\` for a profile
  rm <name>                                  Remove a profile (not "default")
  pool <name> --set <pool> | --none          Move a profile to a named pool
                                              (or remove from every pool)

The config file defaults to ${defaultConfigPath()}.
The implicit "default" profile (${defaultConfigPath().replace(/config\/rclaude\/sentinel\.json$/, '') || '~'}${'/.claude'}) joins the "default" pool unless overridden.
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
  const pools = getPools(cfg).join(',') || '-'
  process.stdout.write(
    `${header}\ndefaultSelection: ${cfg.defaultSelection}\ndefaultPool: ${cfg.defaultPool}\npools: ${pools}\n\nPROFILES\n`,
  )
  const rows: string[][] = [['NAME', 'CONFIG_DIR', 'POOL', 'WEIGHT', 'AUTHED', 'LABEL']]
  const sorted = Object.values(cfg.profiles).sort((a, b) => a.name.localeCompare(b.name))
  for (const p of sorted) {
    rows.push([
      p.name,
      p.configDir,
      p.pool === null ? '-' : p.pool,
      String(p.weight),
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
    string: ['--config-dir', '--label', '--color', '--spawn-root', '--pool', '--weight'],
    boolean: ['--no-pool', '--hide-label'],
  })
  const configDir = stringFlag(flags, '--config-dir')
  if (!configDir) {
    process.stderr.write('add: --config-dir <path> is required\n')
    return 2
  }
  const weightCheck = parseWeightFlag(flags, 'add')
  if (weightCheck.code !== 0) return weightCheck.code
  const poolFlag = stringFlag(flags, '--pool')
  const noPool = flags['--no-pool'] === true
  if (poolFlag && noPool) {
    process.stderr.write('add: --pool <name> and --no-pool are mutually exclusive\n')
    return 2
  }
  if (poolFlag && !POOL_NAME_RE.test(poolFlag)) {
    process.stderr.write(`add: --pool "${poolFlag}" must match [a-z0-9-]{1,63}\n`)
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
  const poolLabel = poolFlag ?? (noPool ? '<excluded>' : DEFAULT_POOL_NAME)
  process.stdout.write(`added profile "${name}" -> ${configDir} (pool: ${poolLabel})\n`)
  // Sanity round-trip: re-load so any rejection surfaces immediately.
  loadSentinelConfig({ configPath })
  return 0
}

/**
 * Mutate display metadata or filesystem fields on an existing profile.
 *
 * Touches ONLY the fields the user explicitly passed -- omitted flags leave
 * the existing value alone. To CLEAR `label` / `color` / `spawn-root`, pass
 * an empty string (`--label ""`). `configDir` cannot be cleared (a profile
 * without one is invalid).
 *
 * Pool changes go through the existing `pool` subcommand because `pool: null`
 * is a meaningful state (excluded from every pool) that flag-style parsing
 * can't distinguish from "field omitted".
 */
function cmdSet(configPath: string, args: string[]): number {
  const nameCheck = validateProfileNameArg(args[0])
  if (nameCheck.code !== 0) return nameCheck.code
  const name = nameCheck.name
  const flags = parseFlags(args.slice(1), {
    string: ['--label', '--color', '--config-dir', '--spawn-root', '--weight'],
    boolean: ['--show-label', '--hide-label'],
  })

  if (flags['--show-label'] === true && flags['--hide-label'] === true) {
    process.stderr.write('set: --show-label and --hide-label are mutually exclusive\n')
    return 2
  }

  const weightCheck = parseWeightFlag(flags, 'set')
  if (weightCheck.code !== 0) return weightCheck.code

  const touched: Array<{ field: string; from: string | undefined; to: string | undefined }> = []
  const file = readRawConfig(configPath)
  const profiles = file.profiles ?? {}
  const entry = profiles[name]
  if (!entry) {
    process.stderr.write(
      `set: profile "${name}" not found in ${configPath} (known: ${Object.keys(profiles).join(', ') || 'none'})\n`,
    )
    return 1
  }

  applyOptionalField(entry, 'label', flags['--label'], touched)
  applyOptionalField(entry, 'color', flags['--color'], touched)
  applyOptionalField(entry, 'spawnRoot', flags['--spawn-root'], touched)

  // showLabel is tri-state: `undefined` (omitted, default = render),
  // `true` (explicit show -- clear any prior `false`), or `false` (hide).
  // CLI exposes only the explicit forms so the user knows what they changed.
  if (flags['--hide-label'] === true && entry.showLabel !== false) {
    touched.push({ field: 'showLabel', from: String(entry.showLabel ?? true), to: 'false' })
    entry.showLabel = false
  } else if (flags['--show-label'] === true && entry.showLabel === false) {
    touched.push({ field: 'showLabel', from: 'false', to: 'true' })
    delete entry.showLabel
  }

  const newConfigDir = stringFlag(flags, '--config-dir')
  if (newConfigDir !== undefined) {
    if (newConfigDir === '') {
      process.stderr.write('set: --config-dir cannot be empty (a profile without configDir is invalid)\n')
      return 2
    }
    if (entry.configDir !== newConfigDir) {
      touched.push({ field: 'configDir', from: entry.configDir, to: newConfigDir })
      entry.configDir = newConfigDir
    }
  }

  if (weightCheck.weight !== undefined && entry.weight !== weightCheck.weight) {
    touched.push({
      field: 'weight',
      from: entry.weight === undefined ? undefined : String(entry.weight),
      to: String(weightCheck.weight),
    })
    entry.weight = weightCheck.weight
  }

  if (touched.length === 0) {
    process.stderr.write(
      'set: no fields specified (use --label, --color, --config-dir, --spawn-root, --weight, --hide-label, --show-label)\n',
    )
    return 2
  }

  profiles[name] = entry
  writeRawConfig(configPath, { ...file, profiles })

  for (const t of touched) {
    const from = t.from ?? '<unset>'
    const to = t.to ?? '<cleared>'
    process.stdout.write(`profile "${name}" ${t.field}: ${from} -> ${to}\n`)
  }
  process.stdout.write(`(restart the sentinel for changes to take effect -- SIGHUP reload not yet implemented)\n`)
  // Sanity round-trip: re-load so any rejection surfaces immediately.
  loadSentinelConfig({ configPath })
  return 0
}

/**
 * Apply a `--<field>` flag value to `entry[key]` if the flag was present.
 *   - Flag absent (`raw === undefined`)            -> no-op.
 *   - Flag with empty string (`--color ""`)         -> clear the field.
 *   - Flag with non-empty string                    -> assign + record the diff.
 * Skips no-op writes (current value === new value) so the touched log
 * only reflects real changes.
 */
function applyOptionalField(
  entry: SentinelProfileFile,
  key: 'label' | 'color' | 'spawnRoot',
  raw: string | true | undefined,
  touched: Array<{ field: string; from: string | undefined; to: string | undefined }>,
): void {
  if (raw === undefined) return
  const next = typeof raw === 'string' && raw !== '' ? raw : undefined
  const prev = entry[key]
  if (prev === next) return
  touched.push({ field: key, from: prev, to: next })
  if (next === undefined) delete entry[key]
  else entry[key] = next
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
  const poolFlag = stringFlag(flags, '--pool')
  const noPool = flags['--no-pool'] === true
  if (label) entry.label = label
  if (color) entry.color = color
  if (spawnRootArg) entry.spawnRoot = spawnRootArg
  if (poolFlag) entry.pool = poolFlag
  if (flags['--hide-label'] === true) entry.showLabel = false
  else if (noPool) entry.pool = null
  // No --pool / --no-pool -> omit, sentinel-config synthesises "default" pool.
  const weight = parseWeightFlag(flags, 'add').weight
  if (weight !== undefined) entry.weight = weight
  return entry
}

/** Parse + validate the `--weight <n>` flag. Returns `{ code: 0, weight }`
 *  where `weight` is `undefined` when the flag is absent (caller keeps the
 *  default of 1), or a finite number `>= 0`. On a malformed value, writes an
 *  error and returns a non-zero code for the caller to propagate. */
function parseWeightFlag(
  flags: Record<string, string | true>,
  cmd: string,
): { code: number; weight: number | undefined } {
  const raw = stringFlag(flags, '--weight')
  if (raw === undefined) return { code: 0, weight: undefined }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(`${cmd}: --weight "${raw}" must be a finite number >= 0\n`)
    return { code: 2, weight: undefined }
  }
  return { code: 0, weight: n }
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
  const { name, pool } = parsed
  const file = readRawConfig(configPath)
  const profiles = file.profiles ?? {}
  const entry = profiles[name]
  if (!entry) {
    const defaultHint =
      name === DEFAULT_PROFILE_NAME
        ? ' (the implicit default profile is in the "default" pool by default -- add it explicitly to change)'
        : ''
    process.stderr.write(`pool: profile "${name}" not found in ${configPath}${defaultHint}\n`)
    return 1
  }
  entry.pool = pool
  profiles[name] = entry
  writeRawConfig(configPath, { ...file, profiles })
  process.stdout.write(`profile "${name}" pool=${pool === null ? '<excluded>' : pool}\n`)
  return 0
}

/** Parse `pool <name> --set <pool>|--none`. */
// fallow-ignore-next-line complexity
function parsePoolArgs(args: string[]): { code: number; name: string; pool: string | null } {
  const name = args[0]
  if (!name) {
    process.stderr.write('pool: missing profile name\n')
    return { code: 2, name: '', pool: null }
  }
  const flag = args[1]
  if (flag === '--none') {
    if (args.length > 2) {
      process.stderr.write('pool: --none takes no value\n')
      return { code: 2, name: '', pool: null }
    }
    return { code: 0, name, pool: null }
  }
  if (flag === '--set') {
    const poolName = args[2]
    if (!poolName) {
      process.stderr.write('pool: --set requires a pool name\n')
      return { code: 2, name: '', pool: null }
    }
    if (!POOL_NAME_RE.test(poolName)) {
      process.stderr.write(`pool: pool name "${poolName}" must match [a-z0-9-]{1,63}\n`)
      return { code: 2, name: '', pool: null }
    }
    return { code: 0, name, pool: poolName }
  }
  process.stderr.write('pool: expected --set <pool-name> or --none\n')
  return { code: 2, name: '', pool: null }
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
  // sentinel.json can hold long-lived OAuth tokens -- owner-only dir + 0600 file.
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  const text = `${JSON.stringify(file, null, 2)}\n`
  writeSecureFileSync(configPath, text)
}

// `homedir` import kept for future tilde-defaults; reference it so the
// unused-import warning stays clean.
void homedir
