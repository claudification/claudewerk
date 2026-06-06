import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { BUILD_VERSION } from '../../../src/shared/version'

interface Props {
  /** Stable name for this boundary -- shown in the fallback and sent to /api/crash. */
  name: string
  children: ReactNode
  /** Visual treatment. 'panel' fills its container; 'modal' is a compact card. */
  variant?: 'panel' | 'modal'
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * Scoped error boundary for a single panel or modal. Unlike the top-level
 * ErrorBoundary (full-screen crash screen), this contains a render failure to
 * its own subtree: the rest of the app keeps working. A bad transcript entry,
 * for example, should take down the transcript panel at worst -- not the whole
 * control panel.
 *
 * Happy path returns `children` verbatim with NO wrapper element, so it adds no
 * DOM box and cannot break the surrounding flex layout. The only cost is one
 * extra fiber node, which React skips entirely unless an error is thrown.
 */
export class PanelBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`PanelBoundary[${this.props.name}] caught:`, error, errorInfo)
    try {
      const store = useConversationsStore.getState()
      fetch('/api/crash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boundary: this.props.name,
          scoped: true,
          error: { name: error.name, message: error.message, stack: error.stack },
          componentStack: errorInfo.componentStack,
          version: BUILD_VERSION.gitHashShort,
          buildTime: BUILD_VERSION.buildTime,
          url: window.location.href,
          conversationId: store.selectedConversationId,
        }),
      }).catch(() => {})
    } catch {}
  }

  retry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const { name, variant = 'panel' } = this.props
    const message = this.state.error?.message || 'An unexpected error occurred.'

    const inner = (
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="text-destructive font-mono text-xs font-bold uppercase tracking-wider">
          {name} failed to render
        </div>
        <div className="text-muted-foreground text-xs max-w-md break-words">{message}</div>
        <button
          type="button"
          onClick={this.retry}
          className="mt-1 rounded border border-border bg-muted/60 px-3 py-1 text-xs font-bold hover:bg-muted transition-colors"
        >
          ↻ Retry
        </button>
        <div className="text-muted-foreground/40 text-[10px]">The rest of the app is still working.</div>
      </div>
    )

    if (variant === 'modal') {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4">
          <div className="rounded-lg border border-destructive/40 bg-card p-5 shadow-xl">{inner}</div>
        </div>
      )
    }

    return <div className="flex h-full w-full items-center justify-center p-6">{inner}</div>
  }
}
