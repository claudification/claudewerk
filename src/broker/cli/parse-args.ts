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
  // backup / archive / maintain commands
  compressorArg: string
  archiveDirArg: string
  monthArg: string
  hotDaysArg: string
  levelArg: string
  targetDbArg: string
  maxBackupAgeArg: string
  healthUrlArg: string
  confirmFlag: boolean
  forceFlag: boolean
  againstDbFlag: boolean
  skipVacuumFlag: boolean
  // archive search
  maxSecondsArg: string
  contextArg: string
  regexFlag: boolean
  caseSensitiveFlag: boolean
  planFlag: boolean
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
  '--compressor': valueFlag('compressorArg'),
  '--archive-dir': valueFlag('archiveDirArg'),
  '--month': valueFlag('monthArg'),
  '--hot-days': valueFlag('hotDaysArg'),
  '--level': valueFlag('levelArg'),
  '--target-db': valueFlag('targetDbArg'),
  '--max-backup-age': valueFlag('maxBackupAgeArg'),
  '--health-url': valueFlag('healthUrlArg'),
  '--confirm': boolFlag('confirmFlag'),
  '--force': boolFlag('forceFlag'),
  '--against-db': boolFlag('againstDbFlag'),
  '--skip-vacuum': boolFlag('skipVacuumFlag'),
  '--max-seconds': valueFlag('maxSecondsArg'),
  '--context': valueFlag('contextArg'),
  '--regex': boolFlag('regexFlag'),
  '--case-sensitive': boolFlag('caseSensitiveFlag'),
  '--plan': boolFlag('planFlag'),
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
  reporter: fillSubCommand,
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
  archive: (result, arg) => {
    if (!result.subCommand) {
      result.subCommand = arg
      return true
    }
    // `archive export 2026-06` -- accept the month positionally as well as via --month.
    if (!result.monthArg && /^\d{4}-\d{2}$/.test(arg)) {
      result.monthArg = arg
      return true
    }
    // `archive search "some phrase"` -- the query is positional, and is checked
    // after the month so `archive search foo 2026-04` narrows rather than
    // searching for "2026-04".
    if (result.subCommand === 'search' && !result.queryArg) {
      result.queryArg = arg
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
    compressorArg: '',
    archiveDirArg: '',
    monthArg: '',
    hotDaysArg: '',
    levelArg: '',
    targetDbArg: '',
    maxBackupAgeArg: '',
    healthUrlArg: '',
    confirmFlag: false,
    forceFlag: false,
    againstDbFlag: false,
    skipVacuumFlag: false,
    maxSecondsArg: '',
    contextArg: '',
    regexFlag: false,
    caseSensitiveFlag: false,
    planFlag: false,
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
