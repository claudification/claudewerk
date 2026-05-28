import type { ReactNode } from 'react'
import { truncate } from '@/lib/utils'
import { AgentTaskBadge } from './agent-task-badge'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'

export function renderAgentTask(name: string, ctx: ToolCaseInput): ToolCaseResult {
  const { input } = ctx
  const desc = input.description as string
  // Canonical: input.agent (was subagent_type in Claude legacy)
  const agentType = input.agent as string
  const prompt = input.prompt as string
  const summary = agentType ? `${agentType}: ${desc}` : desc
  let details = null
  if (prompt) {
    details = (
      <pre className="text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap">
        {truncate(prompt, 2000)}
      </pre>
    )
  }
  // The badge subscribes to its own subagent; the inline agent transcript is
  // wired by ToolLine, which resolves the matched agentId via its own narrow
  // selector. renderAgentTask no longer needs the subagents list at all.
  const agentBadge: ReactNode = name === 'Agent' ? <AgentTaskBadge description={desc} /> : null
  return { summary, details, agentBadge }
}

export function renderAskUserQuestion({ input }: ToolCaseInput): ToolCaseResult {
  const questions = input.questions as Array<{
    question: string
    header?: string
    options?: Array<{ label: string }>
  }>
  let summary: ReactNode = ''
  let details: ReactNode = null
  if (questions?.length) {
    const q0 = questions[0].question
    summary = q0.length > 60 ? `${q0.slice(0, 60)}...` : q0
    details = (
      <div className="text-[10px] font-mono space-y-1 mt-1">
        {questions.map((q, qi) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: question list items are positional, no stable IDs
          // react-doctor-disable-next-line react-doctor/no-array-index-key
          <div key={qi}>
            {q.header && <span className="text-amber-400/70">[{q.header}] </span>}
            <span className="text-foreground/80">{q.question}</span>
            {q.options && (
              <div className="ml-2 text-muted-foreground">
                {q.options.map((o, oi) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: option list items are positional, no stable IDs
                  // react-doctor-disable-next-line react-doctor/no-array-index-key
                  <div key={oi} className="text-amber-400/50">
                    {'>'} {o.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    )
  }
  return { summary, details }
}
