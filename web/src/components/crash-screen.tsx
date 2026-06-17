import type { ErrorInfo } from 'react'
import { getAppState, getLocalStorageDump } from '@/lib/error-report'
import { BUILD_VERSION } from '../../../src/shared/version'

interface CrashScreenProps {
  error: Error | null
  errorInfo: ErrorInfo | null
  copied: boolean
  onCopy: () => void
  onReload: () => void
}

const BANNER = `
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ███████╗██████╗ ██████╗  ██████╗ ██████╗ ██╗                              │
│   ██╔════╝██╔══██╗██╔══██╗██╔═══██╗██╔══██╗██║                              │
│   █████╗  ██████╔╝██████╔╝██║   ██║██████╔╝██║                              │
│   ██╔══╝  ██╔══██╗██╔══██╗██║   ██║██╔══██╗╚═╝                              │
│   ███████╗██║  ██║██║  ██║╚██████╔╝██║  ██║██╗                              │
│   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝                              │
│                                                                             │
│   Something went wrong. But hey, at least it's not a BSOD!                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
`.trim()

const FOOTER = `
┌─────────────────────────────────────────────────────────────────────────────┐
│  Pro tip: Copy the error and share it with someone who can help.            │
│  Blame Zuckerberg if this was caused by a Meta library.                     │
└─────────────────────────────────────────────────────────────────────────────┘
`.trim()

const stackText = (error: Error | null) => error?.stack || 'No stack trace available'

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-border mt-4">
      <div className="p-3 border-b border-border bg-card text-primary font-bold text-sm">[ {title} ]</div>
      <pre className="p-4 text-xs text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto">{body}</pre>
    </div>
  )
}

function ErrorSummary({ error }: { error: Error | null }) {
  const name = error ? error.name : 'Error'
  const message = error ? error.message : 'An unknown error occurred'
  return (
    <div className="border border-destructive bg-destructive/10 p-4 mb-6">
      <div className="text-destructive font-bold mb-2">[ {name} ]</div>
      <div className="text-foreground">{message}</div>
    </div>
  )
}

function BuildInfo() {
  return (
    <div className="border border-border mb-6">
      <div className="p-3 border-b border-border bg-card text-primary font-bold text-sm">[ BUILD INFO ]</div>
      <div className="p-4 text-xs text-muted-foreground space-y-1">
        <div>
          <span className="text-foreground/60">version:</span>{' '}
          <span className="text-accent">{BUILD_VERSION.gitHashShort}</span>{' '}
          <span className="text-foreground/40">({BUILD_VERSION.buildTime})</span>
        </div>
        {BUILD_VERSION.recentCommits?.length > 0 && (
          <div className="mt-2 space-y-0.5">
            {BUILD_VERSION.recentCommits.map(c => (
              <div key={c.hash}>
                <span className="text-accent/70">{c.hash}</span> <span className="text-foreground/60">{c.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function CrashActions({ copied, onCopy, onReload }: Pick<CrashScreenProps, 'copied' | 'onCopy' | 'onReload'>) {
  return (
    <div className="flex gap-4 mb-6">
      <button
        type="button"
        onClick={onCopy}
        className="px-4 py-2 bg-primary text-primary-foreground font-bold text-sm hover:bg-primary/80 transition-colors"
      >
        {copied ? '✓ COPIED!' : '⎘ COPY DETAILS'}
      </button>
      <button
        type="button"
        onClick={onReload}
        className="px-4 py-2 bg-secondary text-secondary-foreground font-bold text-sm hover:bg-secondary/80 transition-colors"
      >
        ↻ RELOAD
      </button>
    </div>
  )
}

/** Full-screen crash UI rendered by the top-level ErrorBoundary. */
export function CrashScreen({ error, errorInfo, copied, onCopy, onReload }: CrashScreenProps) {
  return (
    <div className="min-h-screen bg-background p-8 font-mono">
      <div className="max-w-4xl mx-auto">
        <pre className="text-destructive text-sm mb-6">{BANNER}</pre>
        <ErrorSummary error={error} />
        <BuildInfo />
        <CrashActions copied={copied} onCopy={onCopy} onReload={onReload} />
        <Section title="STACK TRACE" body={stackText(error)} />
        {errorInfo?.componentStack && <Section title="COMPONENT STACK" body={errorInfo.componentStack} />}
        <Section title="APP STATE" body={getAppState()} />
        <Section title="LOCAL SETTINGS" body={getLocalStorageDump()} />
        <div className="mt-6 text-muted-foreground text-xs">
          <pre>{FOOTER}</pre>
        </div>
      </div>
    </div>
  )
}
