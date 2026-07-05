import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_VISIBLE_STATUSES, TASK_STATUSES } from '../../../shared/task-statuses'
import { debug } from '../debug'
import { handleProjectSetStatus } from './project-set-status'
import type { McpToolContext, ToolDef } from './types'

export function registerProjectBoardTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    project_list: {
      description:
        'List tasks from the project board (.rclaude/project/). Returns tasks grouped by status with their frontmatter (title, priority, tags, refs) and relative file paths. By default shows open + in-progress only. To edit tasks, read/write the markdown files directly. To change status, mv the file between status folders.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: [...TASK_STATUSES, 'all'],
            description: `Filter by status folder. Default: all (${DEFAULT_VISIBLE_STATUSES.join(' + ')})`,
          },
          show_done: {
            type: 'boolean',
            description: 'Include done tasks when status is "all" (default: false)',
          },
          show_archived: {
            type: 'boolean',
            description: 'Include archived tasks when status is "all" (default: false)',
          },
          filter: {
            type: 'string',
            description:
              'Filter tasks by glob pattern (matched against title, filename, and tags). Case-insensitive. Examples: "bug*", "*refactor*", "*sqlite*". Wrap in /slashes/ for regex.',
          },
        },
      },
      async handle(params) {
        return handleProjectList(ctx, params)
      },
    },

    project_set_status: {
      description:
        'Move a project task to a different status column on the board. Use the filename (without .md) as the task ID. Avoids needing Bash mv which triggers permission prompts. ' +
        'DONE-GATE: moving to in-review or done may be gated by deterministic checks (per-project gate.conf, or `full` for quest cards). ' +
        "When gated, the tool captures git evidence (branch/base/commits/diffstat, and runs the card's `test_cmd`) and REFUSES the move with a precise reason if the tree is dirty, nothing is committed, the diff is empty, or tests fail. " +
        'Under `full`, in-review -> done additionally requires approval by a DIFFERENT conversation than the one that moved the card to in-review (the worker cannot approve itself). You cannot self-report these facts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description: 'Task filename without .md extension (e.g. "my-task" or "bug-conduit-session")',
          },
          status: {
            type: 'string',
            enum: [...TASK_STATUSES],
            description: 'Target status folder',
          },
        },
        required: ['id', 'status'],
      },
      async handle(params) {
        return handleProjectSetStatus(ctx, params)
      },
    },
  }
}

function handleProjectList(ctx: McpToolContext, params: Record<string, string>) {
  const statusFilter = params.status || 'all'
  let statuses: string[]
  if (statusFilter === 'all') {
    statuses = [...DEFAULT_VISIBLE_STATUSES]
    if (String(params.show_done) === 'true') statuses.push('done')
    if (String(params.show_archived) === 'true') statuses.push('archived')
  } else {
    statuses = [statusFilter]
  }

  let filterRe: RegExp | null = null
  if (params.filter) {
    const f = params.filter
    const regexMatch = f.match(/^\/(.+)\/([gimsuy]*)$/)
    if (regexMatch) {
      filterRe = new RegExp(regexMatch[1], regexMatch[2] || 'i')
    } else {
      const escaped = f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      filterRe = new RegExp(escaped, 'i')
    }
  }

  const dialogCwd = ctx.getDialogCwd()
  const projectDir = join(dialogCwd, '.rclaude', 'project')
  const results: string[] = []
  for (const status of statuses) {
    const dir = join(projectDir, status)
    try {
      const files = readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const { name: file } of files) {
        try {
          const content = readFileSync(join(dir, file), 'utf-8')
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
          const fm = fmMatch ? fmMatch[1] : ''

          if (filterRe) {
            const titleMatch = fm.match(/title:\s*["']?(.+?)["']?\s*$/m)
            const title = titleMatch ? titleMatch[1] : ''
            const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/m)
            const tags = tagsMatch ? tagsMatch[1] : ''
            const searchable = `${file} ${title} ${tags}`
            if (!filterRe.test(searchable)) continue
          }

          const relPath = `.rclaude/project/${status}/${file}`
          results.push(`## ${relPath}\n${fm}`)
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* dir doesn't exist yet */
    }
  }
  const output =
    results.length > 0
      ? results.join('\n\n')
      : params.filter
        ? `No tasks matching "${params.filter}". Try a broader pattern.`
        : 'No tasks found. Create one with: Write .rclaude/project/open/my-task.md'
  debug(
    `[channel] project_list: ${results.length} tasks (filter=${statusFilter}${params.filter ? `, pattern=${params.filter}` : ''})`,
  )
  return { content: [{ type: 'text', text: output }] }
}
