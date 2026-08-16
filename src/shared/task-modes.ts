/**
 * The three things you can ask an agent to do with a card: WORK it, REFINE it,
 * or ANALYZE it.
 *
 * These lived as a private `TEMPLATES` array inside task-batch-selector.tsx, so
 * the only surface that offered anything but "work" was the batch selector. A
 * single card's LAUNCH modal and an epic's action row had no way to reach them
 * without copying the prose, which is how two definitions of "refine" start.
 *
 * `flipsStatus` is the part that is not cosmetic. WORK moves the card
 * in-progress -> in-review because work happened. Asking an agent to READ five
 * cards and report on them must never mark them reviewed -- an ANALYZE run that
 * flipped status was a board that lied about what had been built.
 */

export type TaskMode = 'work' | 'refine' | 'analyze'

export interface TaskModeSpec {
  id: TaskMode
  label: string
  /** Verb for a button that acts on ONE card ("Refine"), title-cased. */
  action: string
  /** The instruction block handed to the agent, for a batch of cards. */
  instructions: string
  /** Single-card variant, used inside the <project-task> wrapper. */
  single: string
  /** Whether the agent should move the card through in-progress / in-review. */
  flipsStatus: boolean
}

export const TASK_MODES: TaskModeSpec[] = [
  {
    id: 'work',
    label: 'Work',
    action: 'Work',
    flipsStatus: true,
    instructions: `Work through the following tasks systematically, one at a time.

For each task:
1. Read the task file for full context
2. Move it to in-progress (project_set_status)
3. Do the work
4. Commit comprehensively after completing each task
5. Move it to in-review when done
6. Proceed to the next task`,
    single: '',
  },
  {
    id: 'refine',
    label: 'Refine',
    action: 'Refine',
    flipsStatus: false,
    instructions: `Refine the following tasks. For each one:
1. Read the task file for full context
2. Improve the description -- be specific about what needs to happen
3. Add missing tags and set appropriate priority
4. Break down large tasks into smaller, actionable sub-tasks
5. Identify dependencies between tasks

Edit the card files themselves. Do NOT change any card's status, and do NOT
start implementing the work.`,
    single: `REFINE this card -- do not implement it.
1. Read the card file for full context, and the code it points at
2. Rewrite the description so it is specific about what must happen
3. Add missing tags and set an appropriate priority
4. Break it into smaller, actionable sub-tasks if it is too large
5. Note any dependencies on other cards

Edit the card file itself. Do NOT change the card's status, and do NOT start
implementing the work.`,
  },
  {
    id: 'analyze',
    label: 'Analyze',
    action: 'Analyze',
    flipsStatus: false,
    instructions: `Analyze the following tasks as a group:
1. Read each task file for full context
2. Identify dependencies and optimal ordering
3. Estimate relative complexity (S/M/L/XL)
4. Flag any tasks that overlap, conflict, or should be merged
5. Suggest which to tackle first and why

Report your analysis, don't start any work. Change nothing on disk.`,
    single: `ANALYZE this card -- report only, change nothing.
1. Read the card file for full context, and the code it points at
2. Say what actually has to change, and where
3. Estimate relative complexity (S/M/L/XL) and call out the risky part
4. Flag anything that makes the card unbuildable as written (missing decisions,
   ambiguity, hidden dependencies on other cards)
5. Recommend whether to work it, refine it first, or drop it

Report your analysis. Do NOT edit any file, and do NOT change the card's status.`,
  },
]

const BY_ID = new Map(TASK_MODES.map(m => [m.id, m]))

/** The spec for a mode, falling back to `work` for an unknown id. */
export function taskMode(id: string | undefined): TaskModeSpec {
  return BY_ID.get((id ?? 'work') as TaskMode) ?? TASK_MODES[0]
}
