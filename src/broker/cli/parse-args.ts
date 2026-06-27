export interface ParsedArgs {
  cacheDir: string
  dataDir: string
  baseUrl: string
  name: string
  command: string
  subCommand: string
  aliasArg: string
  colorArg: string
  cwdArg: string
  permissionsArg: string
  roleArg: string
  credentialIdArg: string
  notBeforeArg: string
  notAfterArg: string
  dryRun: boolean
  dbArg: string
  jsonFlag: boolean
  queryArg: string
  grantArgs: string[]
  allowRoots: string[]
  pathMapArgs: Array<{ from: string; to: string }>
  testPath: string
  destArg: string
  backupArchive: string
  includeBlobs: boolean
  retainHoursArg: string
  retainDaysArg: string
  typeArg: string
  // termination subcommand
  sourceArg: string
  initiatorArg: string
  conversationIdArg: string
  daysArg: string
  limitArg: string
  grepArg: string
  // mint-dev-key command
  asArg: string
  ttlArg: string
}

/** A named-flag handler: applies the flag, returns the last argv index it
 *  consumed (value flags advance past their argument; booleans return `i`). */
type FlagHandler = (result: ParsedArgs, argv: string[], i: number) => number

type StringFlagKey = { [K in keyof ParsedArgs]: ParsedArgs[K] extends string ? K : never }[keyof ParsedArgs]
type BoolFlagKey = { [K in keyof ParsedArgs]: ParsedArgs[K] extends boolean ? K : never }[keyof ParsedArgs]

/** `--flag value` -> result[key] = value. */
const valueFlag =
  (key: StringFlagKey): FlagHandler =>
  (result, argv, i) => {
    result[key] = argv[i + 1]
    return i + 1
  }

/** `--flag` (no value) -> result[key] = true. */
const boolFlag =
  (key: BoolFlagKey): FlagHandler =>
  (result, _argv, i) => {
    result[key] = true
    return i
  }

/** `--flag value` -> result[key].push(value). */
const pushFlag =
  (key: 'grantArgs' | 'allowRoots'): FlagHandler =>
  (result, argv, i) => {
    result[key].push(argv[i + 1])
    return i + 1
  }

/** `--path-map from:to` -> pathMapArgs entry (silently skips a malformed value). */
const pathMapFlag: FlagHandler = (result, argv, i) => {
  const mapping = argv[i + 1]
  const sep = mapping.indexOf(':')
  if (sep > 0) result.pathMapArgs.push({ from: mapping.slice(0, sep), to: mapping.slice(sep + 1) })
  return i + 1
}

/** Named-flag dispatch. Aliases (`--scope`/`--cwd`, `--conversation`/`--conv`)
 *  share one handler. Unknown flags fall through, ignored, as before. */
const FLAG_HANDLERS: Record<string, FlagHandler> = {
  '--cache-dir': valueFlag('cacheDir'),
  '--data-dir': valueFlag('dataDir'),
  '--dry-run': boolFlag('dryRun'),
  '--url': valueFlag('baseUrl'),
  '--name': valueFlag('name'),
  '--grant': pushFlag('grantArgs'),
  '--scope': valueFlag('cwdArg'),
  '--cwd': valueFlag('cwdArg'),
  '--permissions': valueFlag('permissionsArg'),
  '--role': valueFlag('roleArg'),
  '--alias': valueFlag('aliasArg'),
  '--color': valueFlag('colorArg'),
  '--credential-id': valueFlag('credentialIdArg'),
  '--not-before': valueFlag('notBeforeArg'),
  '--not-after': valueFlag('notAfterArg'),
  '--allow-root': pushFlag('allowRoots'),
  '--path-map': pathMapFlag,
  '--db': valueFlag('dbArg'),
  '--json': boolFlag('jsonFlag'),
  '--dest': valueFlag('destArg'),
  '--include-blobs': boolFlag('includeBlobs'),
  '--retain-hours': valueFlag('retainHoursArg'),
  '--retain-days': valueFlag('retainDaysArg'),
  '--type': valueFlag('typeArg'),
  '--source': valueFlag('sourceArg'),
  '--initiator': valueFlag('initiatorArg'),
  '--conversation': valueFlag('conversationIdArg'),
  '--conv': valueFlag('conversationIdArg'),
  '--days': valueFlag('daysArg'),
  '--limit': valueFlag('limitArg'),
  '--grep': valueFlag('grepArg'),
  '--as': valueFlag('asArg'),
  '--ttl': valueFlag('ttlArg'),
}

/** A positional (sub)arg router keyed on the already-parsed `command`. Returns
 *  true when it claimed `arg` into a slot, false when the slot is already full
 *  (the caller then treats `arg` as the next command). */
type PositionalHandler = (result: ParsedArgs, arg: string) => boolean

const fillQueryArg: PositionalHandler = (result, arg) => {
  if (result.queryArg) return false
  result.queryArg = arg
  return true
}

const fillSubCommand: PositionalHandler = (result, arg) => {
  if (result.subCommand) return false
  result.subCommand = arg
  return true
}

/** Command -> positional-slot filler. Commands absent here have no positional
 *  slots, so a bareword under them just becomes the next command. */
const POSITIONAL_HANDLERS: Record<string, PositionalHandler> = {
  'resolve-path': (result, arg) => {
    if (result.testPath) return false
    result.testPath = arg
    return true
  },
  query: fillQueryArg,
  exec: fillQueryArg,
  sentinel: fillSubCommand,
  gateway: fillSubCommand,
  backup: (result, arg) => {
    if (!result.subCommand) {
      result.subCommand = arg
      return true
    }
    if (result.subCommand === 'restore' && !result.backupArchive) {
      result.backupArchive = arg
      return true
    }
    return false
  },
  termination: (result, arg) => {
    if (!result.subCommand) {
      result.subCommand = arg
      return true
    }
    if (result.subCommand === 'grep' && !result.grepArg) {
      result.grepArg = arg
      return true
    }
    return false
  },
}

export function parseArgs(argv: string[], defaultCacheDir: string): ParsedArgs {
  const result: ParsedArgs = {
    cacheDir: defaultCacheDir,
    dataDir: '',
    baseUrl: 'http://localhost:9999',
    name: '',
    command: '',
    subCommand: '',
    aliasArg: '',
    colorArg: '',
    cwdArg: '',
    permissionsArg: '',
    roleArg: '',
    credentialIdArg: '',
    notBeforeArg: '',
    notAfterArg: '',
    dryRun: false,
    dbArg: '',
    jsonFlag: false,
    queryArg: '',
    grantArgs: [],
    allowRoots: [],
    pathMapArgs: [],
    testPath: '',
    destArg: '',
    backupArchive: '',
    includeBlobs: false,
    retainHoursArg: '',
    retainDaysArg: '',
    typeArg: '',
    sourceArg: '',
    initiatorArg: '',
    conversationIdArg: '',
    daysArg: '',
    limitArg: '',
    grepArg: '',
    asArg: '',
    ttlArg: '',
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const flagHandler = FLAG_HANDLERS[arg]
    if (flagHandler) {
      i = flagHandler(result, argv, i)
      continue
    }
    if (!arg.startsWith('-')) {
      // A bareword: try to fill a positional slot for the current command;
      // anything left over becomes the (next) command itself.
      const positional = POSITIONAL_HANDLERS[result.command]
      if (!positional?.(result, arg)) result.command = arg
    }
  }

  return result
}
