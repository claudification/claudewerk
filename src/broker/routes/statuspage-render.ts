/**
 * Statuspage payload -> normalized burst-event + push text.
 *
 * Pure functions only (no I/O, no timers) so the aggregator state machine and
 * its tests can drive them deterministically. status.claude.com sends three
 * shapes we care about: `incident` (carries the MODEL name + the full affected
 * `components[]` snapshot + a human update body), `component_update` (one
 * surface flipping status), and page-only pings we ignore.
 */

// ─── Severity ranks ─────────────────────────────────────────────────────────
// Component status: anything but operational/maintenance counts as "impaired".

const COMPONENT_RANK: Record<string, number> = {
  operational: 0,
  under_maintenance: 0,
  degraded_performance: 1,
  partial_outage: 2,
  major_outage: 3,
}
/** Impact ranks, for detecting escalation of an already-known incident. */
const IMPACT_RANK: Record<string, number> = {
  none: 0,
  maintenance: 0,
  minor: 1,
  major: 2,
  critical: 3,
}

function componentRank(status: string | undefined): number {
  return status ? (COMPONENT_RANK[status] ?? 1) : 0
}
export function impactRank(impact: string | undefined): number {
  return impact ? (IMPACT_RANK[impact] ?? 0) : 0
}
export function isImpaired(status: string | undefined): boolean {
  return componentRank(status) > 0
}

/** Highest component severity across a name->status map (0 = all clear). */
export function maxRank(components: Record<string, string>): number {
  let m = 0
  for (const status of Object.values(components)) {
    const r = componentRank(status)
    if (r > m) m = r
  }
  return m
}

/** Turn a raw component status into human words for a push body. */
function humanStatus(status: string): string {
  const map: Record<string, string> = {
    degraded_performance: 'degraded',
    partial_outage: 'partial outage',
    major_outage: 'major outage',
    under_maintenance: 'maintenance',
    operational: 'operational',
  }
  return map[status] ?? status.replace(/_/g, ' ')
}

// ─── Normalization ──────────────────────────────────────────────────────────

export interface IncidentInfo {
  name: string
  status: string // investigating | identified | monitoring | resolved
  impact: string // none | maintenance | minor | major | critical
  latestBody?: string
}

/** One webhook hit reduced to the facts the aggregator diffs on. */
export interface NormalizedEvent {
  /** component name -> status observed in THIS hit (authoritative for those names). */
  components: Record<string, string>
  incident?: IncidentInfo
  /** true for selftest / validation pings -- ingest should drop these. */
  ignore: boolean
}

interface RawIncident {
  name?: string
  status?: string
  impact?: string
  incident_updates?: Array<{ body?: string }>
  components?: Array<{ name?: string; status?: string }>
}

function looksLikeSelftest(inc: RawIncident, page: { status_description?: string } | undefined): boolean {
  const name = inc.name ?? ''
  return /selftest|\bignore\b/i.test(name) || page?.status_description === 'Test'
}

const IGNORED: NormalizedEvent = { components: {}, ignore: true }

/** The authoritative component snapshot an incident payload carries. */
function collectComponents(inc: RawIncident): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of inc.components ?? []) {
    if (c.name && c.status) out[c.name] = c.status
  }
  return out
}

function toIncidentInfo(inc: RawIncident): IncidentInfo {
  return {
    name: inc.name ?? 'incident',
    status: inc.status ?? 'investigating',
    impact: inc.impact ?? 'none',
    latestBody: inc.incident_updates?.[0]?.body?.trim() || undefined,
  }
}

function normalizeIncident(inc: RawIncident, page: { status_description?: string } | undefined): NormalizedEvent {
  if (looksLikeSelftest(inc, page)) return IGNORED
  return { components: collectComponents(inc), incident: toIncidentInfo(inc), ignore: false }
}

export function normalize(payload: Record<string, unknown>): NormalizedEvent {
  const page = payload.page as { status_description?: string } | undefined
  const incident = payload.incident as RawIncident | undefined
  if (incident) return normalizeIncident(incident, page)

  const component = payload.component as { name?: string; status?: string } | undefined
  const update = payload.component_update as { new_status?: string } | undefined
  const status = update?.new_status ?? component?.status
  if (component?.name && status) return { components: { [component.name]: status }, ignore: false }

  // Page-only ping / validation subscribe / unrecognized: nothing to diff on.
  return IGNORED
}

// ─── Push text ──────────────────────────────────────────────────────────────

export interface Push {
  title: string
  body: string
}

function impactTag(impact: string | undefined): string {
  return impact && impactRank(impact) > 0 ? ` [${impact}]` : ''
}

/** List surfaces, worst first, collapsing the long tail. */
function surfacesText(names: string[]): string {
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`
}

/**
 * One aggregated degradation push. `impaired` is the set of currently-impaired
 * component name->status; `incident` (if present) supplies the model + human body.
 */
export function renderDegrade(impaired: Record<string, string>, incident: IncidentInfo | undefined): Push {
  const names = Object.keys(impaired).sort((a, b) => componentRank(impaired[b]) - componentRank(impaired[a]))
  const worst = names.reduce((w, n) => (componentRank(impaired[n]) > componentRank(impaired[w]) ? n : w), names[0])
  const dominant = humanStatus(impaired[worst] ?? 'degraded_performance')

  const title = incident ? `Claude: ${incident.name}${impactTag(incident.impact)}` : `Claude: ${dominant}`
  const parts = [`${surfacesText(names)}: ${dominant}`]
  if (incident?.latestBody) parts.push(incident.latestBody)
  return { title, body: parts.join(' — ') }
}

/** One aggregated recovery push, fired only when a prior degradation clears. */
export function renderRecovery(incidentName: string | undefined): Push {
  return {
    title: 'Claude recovered',
    body: incidentName ? `${incidentName} resolved — all services operational` : 'All services back to operational',
  }
}
