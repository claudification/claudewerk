/**
 * Sentinel handlers for project-store RPCs. The dispatch in index.ts resolves
 * `projectRoot` (expandPath against spawnRoot) and calls these with the absolute
 * root; every path op below is jailed under it by src/shared/project-store.ts.
 */

import {
  createProjectTask,
  deleteProjectTask,
  getProjectTask,
  getProjectTasksBatch,
  listProjectManifest,
  listProjectTasks,
  moveProjectFile,
  moveProjectTask,
  readProjectFile,
  updateProjectTask,
  writeProjectFile,
} from '../shared/project-store'
import type {
  ProjectBoardOp,
  ProjectBoardResult,
  ProjectMoveFile,
  ProjectMoveFileResult,
  ProjectReadFile,
  ProjectReadFileResult,
  ProjectWriteFile,
  ProjectWriteFileResult,
} from '../shared/protocol'

export function handleProjectReadFile(root: string, msg: ProjectReadFile): ProjectReadFileResult {
  const r = readProjectFile(root, msg.relPath, msg.maxBytes)
  return { type: 'project_read_file_result', requestId: msg.requestId, ...r }
}

export function handleProjectWriteFile(root: string, msg: ProjectWriteFile): ProjectWriteFileResult {
  const r = writeProjectFile(root, msg.relPath, msg.content)
  return { type: 'project_write_file_result', requestId: msg.requestId, ...r }
}

export function handleProjectMoveFile(root: string, msg: ProjectMoveFile): ProjectMoveFileResult {
  const r = moveProjectFile(root, msg.fromRel, msg.toRel)
  return { type: 'project_move_file_result', requestId: msg.requestId, ...r }
}

export function handleProjectBoardOp(root: string, msg: ProjectBoardOp, nowMs: number): ProjectBoardResult {
  const base = { type: 'project_board_result' as const, requestId: msg.requestId, op: msg.op }
  try {
    switch (msg.op) {
      case 'list':
        return { ...base, ok: true, tasks: listProjectTasks(root, msg.filterStatus) }
      case 'manifest':
        return { ...base, ok: true, manifest: listProjectManifest(root) }
      case 'getBatch':
        return { ...base, ok: true, batch: getProjectTasksBatch(root, msg.refs ?? []) }
      case 'get':
        if (!msg.status || !msg.slug) return { ...base, ok: false, error: 'status+slug required' }
        return { ...base, ok: true, task: getProjectTask(root, msg.status, msg.slug) }
      case 'create':
        if (!msg.input) return { ...base, ok: false, error: 'input required' }
        return { ...base, ok: true, note: createProjectTask(root, msg.input, nowMs) }
      case 'update':
        if (!msg.status || !msg.slug) return { ...base, ok: false, error: 'status+slug required' }
        return { ...base, ok: true, task: updateProjectTask(root, msg.status, msg.slug, msg.patch ?? {}) }
      case 'move':
        if (!msg.slug || !msg.fromStatus || !msg.toStatus)
          return { ...base, ok: false, error: 'slug+fromStatus+toStatus required' }
        return { ...base, ok: true, slug: moveProjectTask(root, msg.slug, msg.fromStatus, msg.toStatus, nowMs) }
      case 'delete':
        if (!msg.status || !msg.slug) return { ...base, ok: false, error: 'status+slug required' }
        return { ...base, ok: true, removed: deleteProjectTask(root, msg.status, msg.slug) }
      default:
        return { ...base, ok: false, error: `unknown op: ${msg.op}` }
    }
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message }
  }
}
