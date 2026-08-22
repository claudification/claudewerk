import { cardRelPath, hasLegacyCards, listProjectTasks } from '../../../shared/project-store'
import type { ProjectTaskMeta } from '../../../shared/project-task-types'
import { DEFAULT_VISIBLE_STATUSES, TASK_STATUSES, type TaskStatus } from '../../../shared/task-statuses'
import { debug } from '../debug'
import { handleProjectSetStatus } from './project-set-status'
import type { McpToolContext, ToolDef } from './types'

export function registerProjectBoardTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    project_list: {
      description:
        'List tasks from the project board (.rclaude/project/). Returns tasks with their frontmatter (title, status, priority, tags, refs) and file paths. By default shows open + in-progress only. ' +
        'Every card lives at .rclaude/project/cards/<id>.md and NEVER moves -- its lane is the `status:` frontmatter key. To edit a task, read/write that file directly. To change its lane, use project_set_status (do NOT mv the file).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: [...TASK_STATUSES, 'all'],
            description: `Filter by lane. Default: all (${DEFAULT_VISIBLE_STATUSES.join(' + ')})`,
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
        'Move a project task to a different status column on the board. Use the card id (its filename without .md) -- the file itself never moves, only its `status:` frontmatter changes. ' +
        'DONE-GATE: moving to in-review or done may be gated by deterministic checks (per-project gate.conf, or `full` for quest cards). ' +
        "When gated, the tool captures git evidence (branch/base/commits/diffstat, and runs the card's `test_cmd`) and REFUSES the move with a precise reason if the tree is dirty, nothing is committed, the diff is empty, or tests fail. " +
        'Under `full`, in-review -> done additionally requires approval by a DIFFERENT conversation than the one that moved the card to in-review (the worker cannot approve itself). You cannot self-report these facts. ' +
        'VERDICT: a move OUT of in-review (to done = approve, to in-progress/open = bounce) closes a review, so it REQUIRES `verdict` -- your judgement in your own words. ' +
        'It is written into the card body under `## Verdict`, attributed to your conversation id, BEFORE the lane moves; if it cannot be written the move is refused. ' +
        'A verdict that lives only in your transcript is one no later reader of the board can find.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description: 'Card id -- its filename without .md (e.g. "my-task" or "bug-conduit-session")',
          },
          status: {
            type: 'string',
            enum: [...TASK_STATUSES],
            description: 'Target lane',
          },
          verdict: {
            type: 'string',
            description:
              'REQUIRED when leaving in-review. Your judgement: on approve, what you ran and what you saw; ' +
              'on bounce, exactly what failed and the output that proves it. Markdown. Ignored on other moves.',
          },
          caveats: {
            type: 'string',
            description: 'Optional, with `verdict`: it passes, but watch X. Lands under the verdict on the card.',
          },
          notes: {
            type: 'string',
            description:
              'Optional, with `verdict`: FYI asides still true now the card is settled (e.g. "needs a deploy").',
          },
        },
        required: ['id', 'status'],
      },
      async handle(params) {
        return await handleProjectSetStatus(ctx, params)
      },
    },
  }
}

/** Which lanes the caller asked for. */
function wantedStatuses(params: Record<string, string>): TaskStatus[] {
  const filter = params.status || 'all'
  if (filter !== 'all') return [filter as TaskStatus]
  const statuses = [...DEFAULT_VISIBLE_STATUSES]
  if (String(params.show_done) === 'true') statuses.push('done')
  if (String(params.show_archived) === 'true') statuses.push('archived')
  return statuses
}

/** `/regex/flags` stays a regex; anything else is a case-insensitive glob. */
function compileFilter(raw: string | undefined): RegExp | null {
  if (!raw) return null
  const asRegex = raw.match(/^\/(.+)\/([gimsuy]*)$/)
  if (asRegex) return new RegExp(asRegex[1], asRegex[2] || 'i')
  return new RegExp(raw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i')
}

function renderCard(task: ProjectTaskMeta): string {
  const lines = [`title: ${task.title}`, `status: ${task.status}`]
  if (task.priority) lines.push(`priority: ${task.priority}`)
  if (task.tags.length) lines.push(`tags: [${task.tags.join(', ')}]`)
  if (task.refs.length) lines.push(`refs: [${task.refs.join(', ')}]`)
  if (task.quest) lines.push(`quest: ${task.quest}`)
  if (task.created) lines.push(`created: ${task.created}`)
  return `## ${cardRelPath(task.slug)}\n${lines.join('\n')}`
}

function handleProjectList(ctx: McpToolContext, params: Record<string, string>) {
  const statuses = new Set<TaskStatus>(wantedStatuses(params))
  const filterRe = compileFilter(params.filter)
  const dialogCwd = ctx.getDialogCwd()

  const results = listProjectTasks(dialogCwd)
    .filter(t => statuses.has(t.status))
    .filter(t => !filterRe || filterRe.test(`${t.slug} ${t.title} ${t.tags.join(' ')}`))
    .map(renderCard)

  let output: string
  if (results.length > 0) output = results.join('\n\n')
  else if (params.filter) output = `No tasks matching "${params.filter}". Try a broader pattern.`
  else output = 'No tasks found. Create one with: Write .rclaude/project/cards/my-task.md (with `status: open`)'

  // A board that still has cards in the old lane directories works, but every
  // read pays for scanning them -- say so once, where an agent will see it.
  if (hasLegacyCards(dialogCwd)) {
    output += '\n\n> This board still has cards in legacy status folders. Run `bun run board:upgrade` to drain them.'
  }

  debug(
    `[channel] project_list: ${results.length} tasks (filter=${params.status || 'all'}${params.filter ? `, pattern=${params.filter}` : ''})`,
  )
  return { content: [{ type: 'text', text: output }] }
}
