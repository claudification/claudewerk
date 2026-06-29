/**
 * SOTU dashboard read handlers (WS request/response).
 *
 * Replaces the REST GET endpoints -- dashboard sends typed WS messages,
 * broker replies in-band. No query strings, no HTTP round-trips for
 * real-time state. Admin-gated (CONTROL_PANEL_ONLY).
 */

import type { SotuView } from '../../shared/protocol'
import { listDeskProjects } from '../desk/projects'
import type { HandlerContext, MessageData } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers } from '../message-router'
import { buildSotuView, maybeDistillOnRead } from '../sotu'
import { defaultResolveSotuConfig } from '../sotu/config'
import { readDistillEvals } from '../sotu/eval'
import { projectSlug } from '../sotu/paths'
import { readQueue } from '../sotu/queue'
import { readState } from '../sotu/state'
import { applyWrite, buildConfigView } from './sotu-config'

function sotuView(ctx: HandlerContext, data: MessageData): void {
  const project = typeof data.project === 'string' ? data.project.trim() : ''
  if (!project) {
    ctx.reply({ type: 'sotu_view_result', error: 'project required' })
    return
  }
  // Lazy-regen-if-stale (no-op for fresh/disabled). Never fail the read.
  maybeDistillOnRead(project).catch(() => {})
  const enabled = defaultResolveSotuConfig(project).enabled
  const view: SotuView = buildSotuView({ slug: projectSlug(project), project, enabled, now: Date.now() })
  ctx.reply({ type: 'sotu_view_result', view })
}

function sotuFleet(ctx: HandlerContext, _data: MessageData): void {
  const now = Date.now()
  const projects = listDeskProjects().map(p => {
    const slug = projectSlug(p.projectUri)
    const config = defaultResolveSotuConfig(p.projectUri)
    const state = readState(slug)
    const queue = readQueue(slug)
    const view = buildSotuView({ slug, project: p.projectUri, enabled: config.enabled, now })
    return {
      project: p.label,
      projectUri: p.projectUri,
      slug,
      enabled: config.enabled,
      state,
      queueSize: queue.length,
      view,
      config: buildConfigViewForProject(p.projectUri),
    }
  })
  ctx.reply({ type: 'sotu_fleet_result', projects, ts: now })
}

function sotuEvals(ctx: HandlerContext, data: MessageData): void {
  const project = typeof data.project === 'string' ? data.project.trim() : ''
  if (!project) {
    ctx.reply({ type: 'sotu_evals_result', evals: [], error: 'project required' })
    return
  }
  const limitRaw = Number(data.limit)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 20
  ctx.reply({ type: 'sotu_evals_result', evals: readDistillEvals(projectSlug(project), limit) })
}

function sotuConfigGet(ctx: HandlerContext, data: MessageData): void {
  const project = typeof data.project === 'string' ? data.project.trim() : ''
  if (!project) {
    ctx.reply({ type: 'sotu_config_result', error: 'project required' })
    return
  }
  ctx.reply({ type: 'sotu_config_result', config: buildConfigViewForProject(project), project })
}

function sotuConfigSet(ctx: HandlerContext, data: MessageData): void {
  const project = typeof data.project === 'string' ? data.project.trim() : ''
  if (!project) {
    ctx.reply({ type: 'sotu_config_result', error: 'project required' })
    return
  }
  applyWrite(project, data)
  const config = buildConfigViewForProject(project)
  ctx.log.info(`[sotu] config_set project=${project} enabled=${config.enabled}`)
  ctx.reply({ type: 'sotu_config_result', config, project })
}

function buildConfigViewForProject(project: string): SotuConfigView {
  return buildConfigView(project)
}

export function registerSotuDashboardHandlers(): void {
  registerHandlers(
    {
      sotu_view: sotuView,
      sotu_fleet: sotuFleet,
      sotu_evals: sotuEvals,
      sotu_config_get: sotuConfigGet,
      sotu_config_set: sotuConfigSet,
    },
    CONTROL_PANEL_ONLY,
  )
}
