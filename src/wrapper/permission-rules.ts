/**
 * Permission auto-approve rules for rclaude.
 *
 * Two sources of rules, checked in order:
 * 1. Project-level: .claude/rclaude.json (checked into repo, shared across sessions)
 * 2. Session-level: in-memory Set<toolName> (from dashboard "ALWAYS ALLOW" button, dies with process)
 *
 * If either matches, the wrapper auto-approves without forwarding to dashboard.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

interface PermissionConfig {
  permissions?: Record<string, { allow?: string[] | boolean }>
}

interface RulesEngine {
  /** Check if a permission request should be auto-approved */
  shouldAutoApprove(toolName: string, inputPreview: string): boolean
  /** Add a session-scoped rule (from dashboard ALWAYS ALLOW) */
  addSessionRule(toolName: string): void
  /** Remove a session-scoped rule */
  removeSessionRule(toolName: string): void
  /** Get active session rules */
  getSessionRules(): string[]
  /** Get loaded project rules summary (for diag) */
  getProjectRulesSummary(): Record<string, string[] | boolean>
}

/** Simple glob matching - supports * and ** */
function matchGlob(pattern: string, value: string): boolean {
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

function extractInput(inputPreview: string): Record<string, unknown> {
  try {
    return JSON.parse(inputPreview)
  } catch {
    // Truncated JSON - try regex extraction
    const filePath = inputPreview.match(/"file_path"\s*:\s*"([^"]+)"/)?.[1]
    const command = inputPreview.match(/"command"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/)?.[1]
    return { file_path: filePath, command: command?.replace(/\\"/g, '"').replace(/\\n/g, '\n') }
  }
}

export function createRulesEngine(cwd: string): RulesEngine {
  // Load project rules from .claude/rclaude.json
  let projectRules: PermissionConfig = {}
  const configPath = join(cwd, '.claude', 'rclaude.json')
  if (existsSync(configPath)) {
    try {
      projectRules = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch (err) {
      console.error(`[permission-rules] Failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Session-scoped rules (from dashboard ALWAYS ALLOW button)
  const sessionRules = new Set<string>()

  function checkProjectRules(toolName: string, inputPreview: string): boolean {
    const rules = projectRules.permissions?.[toolName]
    if (!rules?.allow) return false

    // Boolean allow = allow everything for this tool
    if (rules.allow === true) return true

    if (!Array.isArray(rules.allow)) return false

    const input = extractInput(inputPreview)

    // File-based tools: match file_path against patterns
    if (
      toolName === 'Write' ||
      toolName === 'Edit' ||
      toolName === 'Read' ||
      toolName === 'Glob' ||
      toolName === 'Grep'
    ) {
      const filePath = (input.file_path || input.path) as string | undefined
      if (!filePath) return false
      const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
      // Reject paths outside CWD (../something)
      if (rel.startsWith('..')) return false
      return rules.allow.some(pattern => matchGlob(pattern, rel))
    }

    // Bash: match command against patterns
    if (toolName === 'Bash') {
      const command = input.command as string | undefined
      if (!command) return false
      return rules.allow.some(pattern => matchGlob(pattern, command))
    }

    // Other tools: wildcard match
    return rules.allow.includes('*')
  }

  return {
    shouldAutoApprove(toolName: string, inputPreview: string): boolean {
      // 1. Check project rules (.claude/rclaude.json)
      if (checkProjectRules(toolName, inputPreview)) return true
      // 2. Check session rules (ALWAYS ALLOW button)
      if (sessionRules.has(toolName)) return true
      return false
    },

    addSessionRule(toolName: string) {
      sessionRules.add(toolName)
    },

    removeSessionRule(toolName: string) {
      sessionRules.delete(toolName)
    },

    getSessionRules(): string[] {
      return Array.from(sessionRules)
    },

    getProjectRulesSummary(): Record<string, string[] | boolean> {
      const summary: Record<string, string[] | boolean> = {}
      for (const [tool, rule] of Object.entries(projectRules.permissions || {})) {
        if (rule.allow) summary[tool] = rule.allow
      }
      return summary
    },
  }
}
