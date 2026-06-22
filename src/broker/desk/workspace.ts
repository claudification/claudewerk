/**
 * The dispatcher's WORKSPACE -- a virtual filesystem (plan-dispatcher-build.md
 * §10.1, Jonas: "workspace for the virtual file system").
 *
 * NOT the real fs: an in-memory, per-broker-process scratch space the dispatcher
 * can use to do simple tasks itself (draft notes, stage a plan, accumulate
 * findings) without touching disk. Files live under named workspaces (/work/<x>)
 * so each can be reset independently. Ephemeral by design -- it is scratch, not
 * storage; the durable layer is the memory file + threads.
 *
 * Pure + in-memory, so it unit-tests with no IO. Capped (file size + count) so a
 * runaway loop can't balloon broker memory.
 */

import { z } from 'zod'
import { defineTool, type Toolset } from './tool-def'

const MAX_FILE_BYTES = 64 * 1024
const MAX_FILES_PER_WS = 200
const DEFAULT_WS = 'default'

/** workspace name -> (relative path -> content). Module-level: one VFS per process. */
const workspaces = new Map<string, Map<string, string>>()

function filesOf(ws: string): Map<string, string> {
  let m = workspaces.get(ws)
  if (!m) {
    m = new Map()
    workspaces.set(ws, m)
  }
  return m
}

export function writeFile(
  workspace: string,
  path: string,
  content: string,
): { workspace: string; path: string; bytes: number } {
  if (content.length > MAX_FILE_BYTES) throw new Error(`file too large (${content.length} > ${MAX_FILE_BYTES} bytes)`)
  const files = filesOf(workspace)
  if (!files.has(path) && files.size >= MAX_FILES_PER_WS)
    throw new Error(`workspace '${workspace}' is full (${MAX_FILES_PER_WS} files)`)
  files.set(path, content)
  return { workspace, path, bytes: content.length }
}

export function readFile(workspace: string, path: string): string {
  const content = workspaces.get(workspace)?.get(path)
  if (content === undefined) throw new Error(`no file '${path}' in workspace '${workspace}'`)
  return content
}

export function listFiles(workspace: string): string[] {
  return [...(workspaces.get(workspace)?.keys() ?? [])].sort()
}

/** Reset a single workspace (clears /work/<x>). */
export function resetWorkspace(workspace: string): { workspace: string; cleared: number } {
  const cleared = workspaces.get(workspace)?.size ?? 0
  workspaces.delete(workspace)
  return { workspace, cleared }
}

/** A snapshot of every workspace (for the overlay). */
export function workspaceSnapshot(): { workspace: string; files: string[] }[] {
  return [...workspaces.entries()].map(([workspace, files]) => ({ workspace, files: [...files.keys()].sort() }))
}

/** Reset ALL workspaces -- test isolation. */
export function resetAllWorkspaces(): void {
  workspaces.clear()
}

const wsField = z.string().nullable().describe(`Workspace name (/work/<x>). Null = '${DEFAULT_WS}'.`)
const nn = (v: string | null): string => v?.trim() || DEFAULT_WS

/** The dispatcher's workspace toolset (agent-core-shaped). Pure -- no deps. */
export function buildWorkspaceToolset(): Toolset {
  return {
    workspace_write: defineTool({
      description:
        'Write a file in your scratch workspace (a virtual fs, not the real disk). Use it to draft/stage work.',
      inputSchema: z.object({
        workspace: wsField,
        path: z.string().describe('Relative file path.'),
        content: z.string(),
      }),
      execute: a => {
        const args = a as { workspace: string | null; path: string; content: string }
        return writeFile(nn(args.workspace), args.path, args.content)
      },
    }),
    workspace_read: defineTool({
      description: 'Read a file back from your scratch workspace.',
      inputSchema: z.object({ workspace: wsField, path: z.string() }),
      idempotent: true,
      execute: a => {
        const args = a as { workspace: string | null; path: string }
        return readFile(nn(args.workspace), args.path)
      },
    }),
    workspace_list: defineTool({
      description: 'List the files in a scratch workspace.',
      inputSchema: z.object({ workspace: wsField }),
      idempotent: true,
      execute: a => listFiles(nn((a as { workspace: string | null }).workspace)),
    }),
    reset_workspace: defineTool({
      description: 'Clear a scratch workspace (/work/<x>) -- discards all its files.',
      inputSchema: z.object({ workspace: wsField }),
      execute: a => resetWorkspace(nn((a as { workspace: string | null }).workspace)),
    }),
  }
}
