/**
 * Bind the broker-control schemas (control-schemas.ts) to executors over a
 * `ControlToolDeps` backend -> an agent-core-shaped `Toolset` the agent loop
 * runs (plan-dispatcher-build.md §11). Pure + deps-injected so it unit-tests
 * without a live broker; runtime.ts supplies the real store/handler impls.
 *
 * Args are validated by the loop (agent.ts safeParse) before execute runs, so
 * each executor trusts its input shape and just maps nullable -> undefined.
 */

import { controlToolSchemas } from './control-schemas'
import { defineTool, type Toolset } from './tool-def'

/** A conversation row the dispatcher sees (lighter than a full summary). */
export interface ControlConversationRow {
  id: string
  title?: string
  project?: string
  status: string
  liveState?: string
  idleMin?: number
  ctxK?: number
}

/** A gated outcome surfaced to the agent when a very-expensive wake needs the
 *  user's confirmation (B5): the action did NOT run; the agent must ask. */
export interface GateHold {
  conversationId: string
  awaitingConfirmation: true
  cost?: unknown
  note: string
}
/** Either the action's result, or a cost-gate hold the agent must relay. */
type GatedOr<T> = T | GateHold

export interface ControlToolDeps {
  listConversations(opts: { status?: 'live' | 'ended' | 'all'; filter?: string }): ControlConversationRow[]
  inject(conversationId: string, message: string): Promise<GatedOr<{ conversationId: string; delivered: boolean }>>
  interrupt(conversationId: string): Promise<{ conversationId: string }>
  terminate(conversationId: string, reason?: string): Promise<{ conversationId: string }>
  spawn(opts: {
    intent: string
    project?: string
    profile?: string
    worktree?: string
  }): Promise<GatedOr<{ conversationId: string }>>
  revive(conversationId: string): Promise<GatedOr<{ conversationId: string }>>
  configure(opts: {
    conversationId: string
    model?: string
    effort?: string
    permissionMode?: string
  }): Promise<{ conversationId: string; applied: string[] }>
  link(a: string, b: string): Promise<{ linked: true }>
  unlink(a: string, b: string): Promise<{ unlinked: true }>
  readEvents(conversationId: string, limit?: number): Promise<unknown>
}

const nn = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v)

/** Build the broker-control Toolset bound to `deps`. */
export function buildControlToolset(deps: ControlToolDeps): Toolset {
  const s = controlToolSchemas
  return {
    list_conversations: defineTool({
      ...s.list_conversations,
      idempotent: true,
      execute: a => {
        const args = a as { status: 'live' | 'ended' | 'all' | null; filter: string | null }
        return deps.listConversations({ status: nn(args.status), filter: nn(args.filter) })
      },
    }),
    inject: defineTool({
      ...s.inject,
      execute: a => {
        const args = a as { conversationId: string; message: string }
        return deps.inject(args.conversationId, args.message)
      },
    }),
    interrupt: defineTool({
      ...s.interrupt,
      execute: a => deps.interrupt((a as { conversationId: string }).conversationId),
    }),
    terminate: defineTool({
      ...s.terminate,
      execute: a => {
        const args = a as { conversationId: string; reason: string | null }
        return deps.terminate(args.conversationId, nn(args.reason))
      },
    }),
    spawn: defineTool({
      ...s.spawn,
      execute: a => {
        const args = a as { intent: string; project: string | null; profile: string | null; worktree: string | null }
        return deps.spawn({
          intent: args.intent,
          project: nn(args.project),
          profile: nn(args.profile),
          worktree: nn(args.worktree),
        })
      },
    }),
    revive: defineTool({
      ...s.revive,
      execute: a => deps.revive((a as { conversationId: string }).conversationId),
    }),
    configure: defineTool({
      ...s.configure,
      execute: a => {
        const args = a as {
          conversationId: string
          model: string | null
          effort: string | null
          permissionMode: string | null
        }
        return deps.configure({
          conversationId: args.conversationId,
          model: nn(args.model),
          effort: nn(args.effort),
          permissionMode: nn(args.permissionMode),
        })
      },
    }),
    link: defineTool({
      ...s.link,
      execute: a => {
        const args = a as { fromConversationId: string; toConversationId: string }
        return deps.link(args.fromConversationId, args.toConversationId)
      },
    }),
    unlink: defineTool({
      ...s.unlink,
      execute: a => {
        const args = a as { fromConversationId: string; toConversationId: string }
        return deps.unlink(args.fromConversationId, args.toConversationId)
      },
    }),
    read_events: defineTool({
      ...s.read_events,
      idempotent: true,
      execute: a => {
        const args = a as { conversationId: string; limit: number | null }
        return deps.readEvents(args.conversationId, nn(args.limit))
      },
    }),
  }
}
