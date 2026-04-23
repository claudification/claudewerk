/**
 * Project Links - persistent project-pair links for inter-project communication.
 * Links are keyed by project path (stable across restarts/rekeys).
 * Storage: {cacheDir}/project-links.json
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface PersistedLink {
  projectA: string // alphabetically first path (normalized)
  projectB: string // alphabetically second path (normalized)
  createdAt: number
  lastUsed: number
}

interface LinksFile {
  version: 1
  links: PersistedLink[]
}

let linksPath = ''
let links: PersistedLink[] = []

function normalizePath(path: string): string {
  return resolve(path).replace(/\/+$/, '')
}

function linkKey(a: string, b: string): string {
  const na = normalizePath(a)
  const nb = normalizePath(b)
  return na < nb ? `${na}\0${nb}` : `${nb}\0${na}`
}

function sortedPair(a: string, b: string): [string, string] {
  const na = normalizePath(a)
  const nb = normalizePath(b)
  return na < nb ? [na, nb] : [nb, na]
}

function save(): void {
  if (!linksPath) return
  const data: LinksFile = { version: 1, links }
  writeFileSync(linksPath, JSON.stringify(data, null, 2))
}

export function initProjectLinks(cacheDir: string): void {
  linksPath = join(cacheDir, 'project-links.json')
  mkdirSync(dirname(linksPath), { recursive: true })

  // Migrate from legacy session-links.json if needed
  const legacyPath = join(cacheDir, 'session-links.json')
  if (!existsSync(linksPath) && existsSync(legacyPath)) {
    try {
      const raw = JSON.parse(readFileSync(legacyPath, 'utf-8')) as LinksFile
      links = raw.links || []
      // Migrate legacy cwdA/cwdB -> projectA/projectB
      for (const link of links) {
        const legacy = link as unknown as Record<string, unknown>
        if ('cwdA' in legacy && !('projectA' in legacy)) {
          legacy.projectA = legacy.cwdA
          delete legacy.cwdA
        }
        if ('cwdB' in legacy && !('projectB' in legacy)) {
          legacy.projectB = legacy.cwdB
          delete legacy.cwdB
        }
      }
      save() // write as project-links.json
      unlinkSync(legacyPath)
      console.log(`[links] Migrated ${links.length} links from session-links.json -> project-links.json`)
    } catch {
      links = []
    }
  }

  if (existsSync(linksPath)) {
    try {
      const raw = JSON.parse(readFileSync(linksPath, 'utf-8')) as LinksFile
      links = raw.links || []
      // Backward compat: migrate legacy cwdA/cwdB -> projectA/projectB
      for (const link of links) {
        const legacy = link as unknown as Record<string, unknown>
        if ('cwdA' in legacy && !('projectA' in legacy)) {
          legacy.projectA = legacy.cwdA
          delete legacy.cwdA
        }
        if ('cwdB' in legacy && !('projectB' in legacy)) {
          legacy.projectB = legacy.cwdB
          delete legacy.cwdB
        }
      }
      // Evict links not used in 90 days
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
      const before = links.length
      links = links.filter(l => l.lastUsed > cutoff)
      if (links.length < before) save()
      console.log(`[links] Loaded ${links.length} persisted project links (evicted ${before - links.length} stale)`)
    } catch {
      links = []
    }
  }
}

export function getPersistedLinks(): PersistedLink[] {
  return links
}

export function findLink(projectA: string, projectB: string): PersistedLink | null {
  const key = linkKey(projectA, projectB)
  return links.find(l => linkKey(l.projectA, l.projectB) === key) || null
}

export function addPersistedLink(projectA: string, projectB: string): PersistedLink {
  const existing = findLink(projectA, projectB)
  if (existing) {
    existing.lastUsed = Date.now()
    save()
    return existing
  }
  const [a, b] = sortedPair(projectA, projectB)
  const link: PersistedLink = { projectA: a, projectB: b, createdAt: Date.now(), lastUsed: Date.now() }
  links.push(link)
  save()
  console.log(`[links] Persisted: ${a} <-> ${b}`)
  return link
}

export function removePersistedLink(projectA: string, projectB: string): boolean {
  const key = linkKey(projectA, projectB)
  const idx = links.findIndex(l => linkKey(l.projectA, l.projectB) === key)
  if (idx >= 0) {
    const removed = links.splice(idx, 1)[0]
    save()
    console.log(`[links] Removed: ${removed.projectA} <-> ${removed.projectB}`)
    return true
  }
  return false
}

export function touchLink(projectA: string, projectB: string): void {
  const existing = findLink(projectA, projectB)
  if (existing) {
    existing.lastUsed = Date.now()
    save()
  }
}

export function getLinksForProject(project: string): PersistedLink[] {
  const n = normalizePath(project)
  return links.filter(l => l.projectA === n || l.projectB === n)
}
