import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { buildErrorReport, copyTextToClipboard, getAppState, getLocalStorageDump } from '@/lib/error-report'
import { clearCacheAndReload } from '@/lib/utils'
import { BUILD_VERSION } from '../../../src/shared/version'
import { CrashScreen } from './crash-screen'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
  copied: boolean
  /** URL captured at crash time. RELOAD navigates to `/`, so reading the live
   * href later would lose the location that actually crashed. */
  crashUrl: string
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null, copied: false, crashUrl: '' }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error, crashUrl: window.location.href }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ error, errorInfo, crashUrl: window.location.href })
    console.error('ErrorBoundary caught:', error, errorInfo)
    this.reportCrash(error, errorInfo)
    // Signal SW to bypass cache on next page load (browser refresh).
    // main.tsx checks this flag and nukes SW + caches before React renders.
    try {
      localStorage.setItem('sw-crash-detected', '1')
    } catch {}
  }

  reportCrash(error: Error, errorInfo: ErrorInfo) {
    try {
      const store = useConversationsStore.getState()
      const conversation = store.selectedConversationId
        ? store.conversationsById[store.selectedConversationId]
        : undefined
      fetch('/api/crash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: { name: error.name, message: error.message, stack: error.stack },
          componentStack: errorInfo.componentStack,
          appState: getAppState(),
          localStorage: getLocalStorageDump(),
          version: BUILD_VERSION.gitHashShort,
          buildTime: BUILD_VERSION.buildTime,
          url: this.state.crashUrl || window.location.href,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          touch: navigator.maxTouchPoints > 0,
          conversationId: store.selectedConversationId,
          conversationStatus: conversation?.status,
          conversationProject: conversation?.project,
        }),
      }).catch(() => {})
    } catch {}
  }

  async copyError() {
    const ok = await copyTextToClipboard(
      buildErrorReport({
        error: this.state.error,
        componentStack: this.state.errorInfo?.componentStack,
        url: this.state.crashUrl,
      }),
    )
    if (ok) {
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2000)
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <CrashScreen
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          copied={this.state.copied}
          onCopy={() => this.copyError()}
          onReload={() => clearCacheAndReload({ toRoot: true })}
        />
      )
    }

    return this.props.children
  }
}
