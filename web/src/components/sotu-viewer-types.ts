/**
 * SOTU viewer wire/view types -- shared by the modal container (sotu-viewer.tsx)
 * and its presentational sections (sotu-viewer-sections.tsx). Kept in one place
 * so neither file owns the shape the other reads off the wire.
 */

export interface ChronicleEntry {
  convId: string
  title?: string
  detail: string
  ts: number
}

export interface SotuViewData {
  project: string
  enabled: boolean
  chronicle: {
    now: ChronicleEntry[]
    justDone: ChronicleEntry[]
    narrative: string
    generatedAt: number
  }
  holds: Array<{ kind: string; target: string; holders: Array<{ convId: string }>; contended: boolean }>
  alerts: string[]
  builtAt: number
}

export interface FleetProject {
  project: string
  projectUri: string
  enabled: boolean
  queueSize: number
  view: SotuViewData
}

export type Tab = 'project' | 'universe'
