/**
 * Descriptions + JSON schemas for the `schedule_*` tools.
 *
 * Held apart from the handlers so `schedule.ts` reads as behaviour rather than
 * as a wall of prose. The descriptions carry the two facts an agent cannot
 * infer and will otherwise get wrong: a schedule fires UNATTENDED (so writes
 * need benevolent trust), and every time is meaningless without its zone.
 */

import { SCHEDULE_ACTIONS } from '../../../shared/scheduled-task'

const ID = { id: { type: 'string', description: 'Schedule id (sch_...), from schedule_list' } } as const

/**
 * WHAT a schedule fires, and the payload each kind needs.
 *
 * Shared by create and update so the two cannot drift: a field the engine reads
 * but only one tool can set is a field an agent can write and never fix.
 */
const ACTION = {
  action: {
    type: 'string',
    enum: [...SCHEDULE_ACTIONS],
    description:
      'WHAT fires. "spawn" (default) launches a conversation from `prompt`. "board-sweep" runs the morning ' +
      'report\'s board op and launches nothing. "epic-start" ARMS an epic run (`epic_id`) and launches nothing -- ' +
      'the epic engine dispatches from there. Only "spawn" reads `prompt`; the other two never look at one.',
  },
  epic_id: {
    type: 'string',
    description: 'epic-start: the epic CARD id (file name without .md) to arm. Required for that action.',
  },
  when: {
    type: 'string',
    description:
      'epic-start: the DISPATCH GATE of the armed run -- "now", "window", "queue", an ISO instant with an offset, ' +
      'or a comma-separated composition. This is NOT when the schedule fires (that is `cron`/`runAt`): the ' +
      'schedule decides when the run is ARMED, `when` decides when the armed run may start dispatching.',
  },
  target: { type: 'string', enum: ['pr', 'merged', 'shipped'], description: 'epic-start: delivery rung.' },
  concurrency: { type: 'number', description: 'epic-start: max werk-workers in flight (epic default 3).' },
  max_gens: { type: 'number', description: 'epic-start: werk-master generation ceiling (epic default 40).' },
  max_usd: { type: 'number', description: 'epic-start: USD ceiling for the whole run (epic default 100).' },
  max_wall_clock_minutes: {
    type: 'number',
    description: 'epic-start: unattended wall-clock ceiling in minutes (epic default 480).',
  },
} as const

const WHEN_NOTE =
  'WHEN: pass EITHER `cron` (repeating, 5 fields, Vixie syntax) OR `runAt` (one-shot, epoch ms) -- never both, never neither. ' +
  "Times are evaluated in `tz` (IANA), which defaults to THIS HOST's zone; the broker container runs UTC, so an unzoned time would fire at the wrong hour."

export const SCHEDULE_TOOL_SCHEMAS = {
  list: {
    description:
      'List SCHEDULES -- unattended runs that fire on their own clock (the control panel calls these "Scheduled Tasks"). ' +
      'NOT the same as TaskCreate todos. Defaults to your own project; naming another project requires benevolent trust.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectUri: { type: 'string', description: 'Filter to a project URI. Omit for your own project.' },
      },
    },
  },

  get: {
    description:
      'Read one schedule in full: when it runs, when it NEXT runs, where, who owns it, its policies, and recent run history -- including the fires that launched nothing (skipped_overlap / missed / error). ' +
      'A schedule that quietly never runs looks different here from one that runs fine.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...ID,
        runLimit: { type: 'number', description: 'How many history rows to include (default 10)' },
      },
      required: ['id'],
    },
  },

  create: {
    description:
      'Arm a new SCHEDULE: work that fires on its own clock, with nobody at the keyboard. ' +
      'Requires BENEVOLENT trust -- the human approval dialog that vets an ordinary spawn cannot help at 03:00, so the vetting is this call. ' +
      `The schedule runs as a real USER (see \`owner\`), whose spawn permission is re-checked at every fire. ${WHEN_NOTE} ` +
      'WHAT it fires is `action`: a spawn from `prompt` (the default), the morning board sweep, or an EPIC ARM ' +
      '(`action=epic-start` + `epic_id`) -- which is how "start the migration epic at 02:00 on Saturday" happens ' +
      'without a human pressing RUN. `prompt` is required for a spawn and ignored by the other two. ' +
      'WHERE defaults to your own project and its root directory (any worktree path is folded back to the repo, since a worktree outlives its schedule by less than the schedule outlives it).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short name, shown in the panel' },
        prompt: {
          type: 'string',
          description:
            'spawn: what the run should DO. This is the entire payload -- be specific. Required for action=spawn ' +
            '(the default) and meaningless for every other action.',
        },
        ...ACTION,
        cron: {
          type: 'string',
          description: 'Repeating: 5-field cron, e.g. "0 9 * * 1-5". Mutually exclusive with runAt.',
        },
        runAt: { type: 'number', description: 'One-shot: the exact instant, epoch ms. Mutually exclusive with cron.' },
        tz: { type: 'string', description: 'IANA zone, e.g. "Europe/Berlin". Defaults to this host\'s zone.' },
        projectUri: { type: 'string', description: 'Target project. Defaults to your own.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the project root.' },
        sentinel: { type: 'string', description: 'Sentinel alias to run on. Omit for the default host.' },
        owner: {
          type: 'string',
          description:
            'Registered user the schedule runs AS. Omit when exactly one user holds spawn permission; required when several do.',
        },
        model: { type: 'string', description: 'Model for the spawned run' },
        overlap: {
          type: 'string',
          enum: ['skip', 'parallel'],
          description: 'Previous run still alive: skip (default) or fire anyway',
        },
        catchUp: {
          type: 'string',
          enum: ['skip', 'once'],
          description: 'Missed by an outage: skip (default) or re-run once if <6h stale',
        },
        maxRuns: { type: 'number', description: 'Disarm after N runs' },
        enabled: { type: 'boolean', description: 'Armed on creation (default true)' },
      },
      // `prompt` is NOT required here any more: it is required for `spawn` alone,
      // and the server says so per action (`checkAction`). A schema-level
      // requirement would force a board sweep and an epic arm to invent a
      // sentence neither of them ever reads.
      required: ['name'],
    },
  },

  update: {
    description:
      'Change a schedule -- including ENABLE and DISABLE via `enabled`. Requires benevolent trust. ' +
      'Only the fields you pass change; everything else is left alone. The merged record is re-validated, so a change that produces an impossible schedule is refused rather than saved. ' +
      'Re-enabling also clears the consecutive-failure count.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...ID,
        enabled: {
          type: 'boolean',
          description: 'true = arm it, false = disable it (keeps the record and its history)',
        },
        name: { type: 'string' },
        prompt: { type: 'string' },
        ...ACTION,
        cron: { type: 'string', description: 'New 5-field cron' },
        runAt: { type: 'number', description: 'New one-shot instant (epoch ms, must be future)' },
        tz: { type: 'string', description: 'New IANA zone' },
        cwd: { type: 'string' },
        sentinel: { type: 'string' },
        overlap: { type: 'string', enum: ['skip', 'parallel'] },
        catchUp: { type: 'string', enum: ['skip', 'once'] },
        maxRuns: { type: 'number' },
      },
      required: ['id'],
    },
  },

  delete: {
    description:
      'Delete a schedule AND its run history, permanently. Requires benevolent trust. ' +
      'To stop a schedule without losing the record, prefer schedule_update with enabled:false.',
    inputSchema: { type: 'object' as const, properties: { ...ID }, required: ['id'] },
  },

  run_now: {
    description:
      'Fire a schedule immediately, off-schedule. Requires benevolent trust. ' +
      'Does NOT stamp the fire marker, so running it during a scheduled minute neither suppresses nor doubles the real run.',
    inputSchema: { type: 'object' as const, properties: { ...ID }, required: ['id'] },
  },
} as const
