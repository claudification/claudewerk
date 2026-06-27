import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { BUILD_VERSION } from '../../../src/shared/version'

/** localStorage keys worth capturing in a crash report. */
const LOCAL_STORAGE_KEYS = ['control-panel-prefs', 'rclaude-terminal-settings']

/** Detail lines for the selected conversation. Split out to keep getAppState lean. */
function conversationLines(conversation: Conversation, transcriptEntries: unknown[] | undefined): string[] {
  const connectionIds = (conversation.connectionIds || []).map((w: string) => w.slice(0, 8)).join(', ')
  return [
    `  conversation.status: ${conversation.status}`,
    `  conversation.project: ${conversation.project}`,
    `  conversation.eventCount: ${conversation.eventCount}`,
    `  conversation.connectionIds: [${connectionIds}]`,
    `  transcriptEntries: ${transcriptEntries?.length ?? 0}`,
    `  subagentCount: ${conversation.subagents?.length ?? 0}`,
    `  taskCount: ${conversation.taskCount ?? 0}`,
  ]
}

/** Multi-line snapshot of the conversations store + viewport, for crash reports. */
export function getAppState(): string {
  try {
    const store = useConversationsStore.getState()
    const id = store.selectedConversationId
    const conversation = id ? store.conversationsById[id] : undefined
    const lines = [
      `  selectedConversation: ${id?.slice(0, 8) || '(none)'}`,
      `  conversationCount: ${Object.keys(store.conversationsById).length}`,
      `  expandAll: ${store.expandAll}`,
      `  showTerminal: ${store.showTerminal}`,
      `  wsConnected: ${store.isConnected}`,
      `  viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
      `  touch: ${navigator.maxTouchPoints > 0}`,
    ]
    if (conversation) lines.push(...conversationLines(conversation, id ? store.transcripts[id] : undefined))
    return lines.join('\n')
  } catch (e) {
    return `  (failed to read store: ${e})`
  }
}

/** Dump of whitelisted localStorage keys, for crash reports. */
export function getLocalStorageDump(): string {
  try {
    const entries: string[] = []
    for (const key of LOCAL_STORAGE_KEYS) {
      const val = localStorage.getItem(key)
      if (val) entries.push(`  ${key}: ${val}`)
    }
    return entries.length > 0 ? entries.join('\n') : '  (none)'
  } catch {
    return '  (localStorage unavailable)'
  }
}

export interface ErrorReportInput {
  error: Error | null
  componentStack?: string | null
  /** Boundary identifier. Omitted for the top-level full-screen boundary. */
  boundary?: string
  /** True for scoped panel/modal boundaries that contain the failure. */
  scoped?: boolean
  /** URL captured at crash time; falls back to the live href. */
  url?: string
}

/**
 * Build a paste-ready Markdown error report. Shared by every error boundary so
 * "Copy details" produces identical, complete output wherever a crash happens.
 */
export function buildErrorReport(input: ErrorReportInput): string {
  const { error, componentStack, boundary, scoped, url } = input
  const fence = (body: string) => `\`\`\`\n${body?.trim() || '(none)'}\n\`\`\``

  const lines: string[] = ['# Control Panel -- Error Report', '']

  lines.push('| Field | Value |', '| --- | --- |')
  if (boundary) lines.push(`| Boundary | ${boundary}${scoped ? ' (scoped)' : ''} |`)
  lines.push(`| Timestamp | ${new Date().toISOString()} |`)
  lines.push(`| URL | ${url || window.location.href} |`)
  lines.push(`| Version | \`${BUILD_VERSION.gitHashShort}\` (${BUILD_VERSION.buildTime}) |`)
  lines.push(`| Viewport | ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x |`)
  lines.push(`| Touch | ${navigator.maxTouchPoints > 0} |`)
  lines.push(`| User Agent | ${navigator.userAgent} |`)
  lines.push('')

  lines.push('## Error', '', `**${error?.name || 'Error'}:** ${error?.message || 'No message'}`, '')
  lines.push('## Stack Trace', '', fence(error?.stack || ''), '')
  if (componentStack) lines.push('## Component Stack', '', fence(componentStack), '')
  lines.push('## App State', '', fence(getAppState()), '')
  lines.push('## Local Settings', '', fence(getLocalStorageDump()), '')

  const commits = BUILD_VERSION.recentCommits || []
  if (commits.length > 0) {
    lines.push('## Recent Commits', '')
    for (const c of commits) lines.push(`- \`${c.hash}\` ${c.message}`)
    lines.push('')
  }

  return lines.join('\n')
}

/** Copy text to the clipboard with an execCommand fallback. Returns success. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch {
      return false
    }
  }
}
