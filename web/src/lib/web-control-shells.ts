/**
 * Agent-attached host shells -- the set of shells the agent is driving in the
 * background. Each attached shell is rendered by AgentShellHost into an
 * OFF-SCREEN ShellPane: mounted (so it subscribes, receives the sentinel replay
 * + live bytes, and registers an xterm buffer in the registry for read/
 * screenshot) but never popped into the fullscreen overlay -- so it never gets
 * in the user's way. This is the "detached / minimized debug shell" model.
 */

import { create } from 'zustand'

interface AgentShellsState {
  /** shellId -> true while the agent has it attached (off-screen mounted). */
  attached: Record<string, true>
  attach(shellId: string): void
  detach(shellId: string): void
}

export const useAgentShellsStore = create<AgentShellsState>(set => ({
  attached: {},
  attach: shellId => set(s => (s.attached[shellId] ? s : { attached: { ...s.attached, [shellId]: true } })),
  detach: shellId =>
    set(s => {
      if (!s.attached[shellId]) return s
      const { [shellId]: _drop, ...rest } = s.attached
      return { attached: rest }
    }),
}))
