import type { ReactNode } from 'react'

export interface ToolCaseResult {
  summary: ReactNode
  details: ReactNode
  inlineContent?: ReactNode
  agentBadge?: ReactNode
}

export interface ToolCaseInput {
  input: Record<string, unknown>
  result?: string
  toolUseResult?: Record<string, unknown>
  isError?: boolean
  conversationPath?: string
  expandAll: boolean
  planContent?: string
  planPath?: string
}
