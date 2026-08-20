/**
 * Sentinel handlers for project-store RPCs. The dispatch in index.ts resolves
 * `projectRoot` (expandPath against spawnRoot) and calls these with the absolute
 * root; every path op below is jailed under it by src/shared/project-store.ts.
 */

import { pinnedEpicRows } from '../shared/pinned-epic-rows'
import {
  createProjectTask,
  deleteProjectTask,
  getProjectTask,
  getProjectTasksBatch,
  listProjectManifest,
  listProjectTasks,
  moveProjectFile,
  readProjectFile,
  setProjectTaskStatus,
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
import { scanPromiseLedger } from './promise-scan'

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

/** What a board op returns on success -- merged onto the result envelope. */
type OpPayload = Partial<Omit<ProjectBoardResult, 'type' | 'requestId' | 'op' | 'ok'>>
type OpHandler = (root: string, msg: ProjectBoardOp, nowMs: number) => OpPayload | { error: string }

/**
 * One entry per op (STRATEGY MAPS OVER CHAINS). `msg.status` / `msg.fromStatus`
 * are legacy HINTS from an older broker -- a card is addressed by id alone, so
 * they are accepted and ignored rather than required.
 */
const OPS: Record<ProjectBoardOp['op'], OpHandler> = {
  list: (root, msg) => ({ tasks: listProjectTasks(root, msg.filterStatus) }),
  manifest: root => ({ manifest: listProjectManifest(root) }),
  getBatch: (root, msg) => ({ batch: getProjectTasksBatch(root, msg.refs ?? []) }),
  // THE WALL's A8 fold, run beside the files. The pin is a frontmatter key only
  // the full card carries, so a browser-side fold had to pull every project's
  // whole board across the wire to find a handful of booleans; this reads the
  // same cards off local disk and sends back only the rows.
  //
  // `msg.project` is the canonical URI the row is an address for -- INFORMATIONAL
  // only, never a path (`root` is the sole path input, jailed as always).
  pinned: (root, msg) => ({ pinned: pinnedEpicRows(msg.project ?? '', listProjectTasks(root)) }),
  // The promise ledger, folded beside the files for a STRONGER version of the
  // reason `pinned` is: the pin at least survives the wire as a boolean, whereas
  // a `promise:` block is NESTED front matter and the board's flat parser has
  // already dropped it by the time a card is a `ProjectTaskMeta`. There is
  // nothing on the wire to fold in the browser. This also runs git, which only
  // the sentinel may -- see promise-git.ts for why every uncertain answer is
  // `null` and never `false`.
  promises: (root, msg, nowMs) => ({ promises: scanPromiseLedger(root, msg.project ?? '', nowMs) }),
  get: (root, msg) => (msg.slug ? { task: getProjectTask(root, msg.slug) } : { error: 'slug required' }),
  create: (root, msg, nowMs) =>
    msg.input ? { note: createProjectTask(root, msg.input, nowMs) } : { error: 'input required' },
  update: (root, msg) =>
    msg.slug ? { task: updateProjectTask(root, msg.slug, msg.patch ?? {}) } : { error: 'slug required' },
  move: (root, msg, nowMs) => {
    if (!msg.slug || !msg.toStatus) return { error: 'slug+toStatus required' }
    const moved = setProjectTaskStatus(root, msg.slug, msg.toStatus, nowMs) !== null
    // The returned id is unchanged: a lane change can no longer rename a card.
    return { slug: moved ? msg.slug : null }
  },
  delete: (root, msg) => (msg.slug ? { removed: deleteProjectTask(root, msg.slug) } : { error: 'slug required' }),
}

export function handleProjectBoardOp(root: string, msg: ProjectBoardOp, nowMs: number): ProjectBoardResult {
  const base = { type: 'project_board_result' as const, requestId: msg.requestId, op: msg.op }
  const handler = OPS[msg.op]
  if (!handler) return { ...base, ok: false, error: `unknown op: ${msg.op}` }
  try {
    const result = handler(root, msg, nowMs)
    if ('error' in result && typeof result.error === 'string') return { ...base, ok: false, error: result.error }
    return { ...base, ok: true, ...result }
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message }
  }
}
