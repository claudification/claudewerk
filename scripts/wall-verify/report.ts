import type { AspectResult, Verdict } from './types'

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  amber: '\x1b[33m',
  blue: '\x1b[34m',
}

const MARK: Record<Verdict, string> = {
  VERIFIED: `${C.green}PASS${C.reset}`,
  MISSING: `${C.red}${C.bold}GONE${C.reset}`,
  PENDING: `${C.dim}....${C.reset}`,
  BLOCKED: `${C.amber}WAIT${C.reset}`,
  UNDELIVERABLE: `${C.red}${C.bold}DEAD${C.reset}`,
}

const rule = (ch: string) => ch.repeat(78)
const banner = (title: string, color: string) => `\n${color}${C.bold}${rule('=')}\n  ${title}\n${rule('=')}${C.reset}\n`

function summary(total: number, count: (v: Verdict) => number): string[] {
  return [
    banner('THE WALL -- DELIVERY VERIFICATION', C.blue),
    `  ${total} promised aspects   ` +
      `${C.green}${count('VERIFIED')} verified${C.reset}   ` +
      `${C.dim}${count('PENDING')} pending${C.reset}   ` +
      `${C.amber}${count('BLOCKED')} blocked${C.reset}   ` +
      `${C.red}${count('MISSING')} missing   ${count('UNDELIVERABLE')} CANNOT DELIVER${C.reset}\n`,
  ]
}

const waitLines = (rows: AspectResult[]): string[] =>
  rows.flatMap(r => `  ${C.amber}WAIT${C.reset} ${r.aspect.code}: ${r.failures[0]}`)

function loudRows(r: AspectResult, withCard: boolean): string[] {
  const head = [`  ${C.bold}${r.aspect.code}${C.reset}  ${r.aspect.promise}`]
  const card = withCard ? [`      card: ${r.aspect.card} (${r.cardStatus})`] : []
  return [...head, ...card, ...r.failures.map(f => `      ${C.red}${f}${C.reset}`), '']
}

/** One block per failing aspect, ABOVE the table. A coloured row inside a
 *  twenty-row table is not an announcement. */
function loudBlock(title: string, rows: AspectResult[], withCard: boolean): string[] {
  if (rows.length === 0) return []
  return [banner(title, C.red), ...rows.flatMap(r => loudRows(r, withCard))]
}

const deadAdvice = (n: number): string[] =>
  n === 0
    ? []
    : [
        `  ${C.amber}Nobody is building these feeds. Build one, or renegotiate the promise.${C.reset}`,
        `  ${C.amber}Do not fake it and do not quietly drop it.${C.reset}\n`,
      ]

function tableRow(r: AspectResult): string {
  const progress = r.total > 0 ? `${r.passed}/${r.total}` : '-'
  return (
    `  ${MARK[r.verdict]}  ${r.aspect.code.padEnd(8)} ${progress.padEnd(6)} ` +
    `${r.aspect.promise.slice(0, 58).padEnd(58)} ${C.dim}${r.cardStatus}${C.reset}`
  )
}

const table = (results: AspectResult[]): string[] => [
  `${C.dim}${rule('-')}${C.reset}`,
  ...results.map(tableRow),
  `${C.dim}${rule('-')}${C.reset}`,
]

const closer = (broken: number, todo: number): string[] =>
  broken === 0 ? [`\n  ${C.green}Nothing is broken. ${todo} aspect(s) still to build.${C.reset}\n`] : []

export function render(results: AspectResult[]): string {
  const by = (v: Verdict) => results.filter(r => r.verdict === v)
  const dead = by('UNDELIVERABLE')
  const gone = by('MISSING')
  const blocked = by('BLOCKED')

  return [
    ...summary(results.length, v => by(v).length),
    ...waitLines(blocked),
    ...loudBlock(`CANNOT DELIVER -- ${dead.length} ASPECT(S) HAVE NO FEED AND NO OWNER`, dead, true),
    ...deadAdvice(dead.length),
    ...loudBlock(`FALSE DONE -- ${gone.length} SETTLED CARD(S) DID NOT DELIVER`, gone, false),
    ...table(results),
    ...closer(dead.length + gone.length, by('PENDING').length + blocked.length),
  ].join('\n')
}

/** Exit code carries the verdict so a beat hook can gate on it. */
export function exitCode(results: AspectResult[]): number {
  if (results.some(r => r.verdict === 'UNDELIVERABLE')) return 2
  if (results.some(r => r.verdict === 'MISSING')) return 1
  return 0
}
