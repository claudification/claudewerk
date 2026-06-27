/**
 * Dev component harness route: `/dev/harness?mount=<id>&key=<devToken>`.
 *
 * Mounts ONE component (see mount-registry) against the REAL broker as the
 * impersonated user encoded in the dev key -- no full app shell, no auth UI.
 * The dev token is injected as the `cw-session` cookie before the WS handshake,
 * so the broker authenticates the socket AS that user (only when the broker has
 * DEV_HARNESS_ENABLED=1). This whole route is gated by `import.meta.env.DEV`, so
 * it never exists in a production bundle.
 */
import { Suspense } from 'react'
import { useWebSocket } from '@/hooks/use-websocket'
import { ErrorSurface } from './error-surface'
import { MOUNT_IDS, MOUNTS } from './mount-registry'

function readParams(): { mount: string; key: string } {
  const p = new URLSearchParams(window.location.search)
  return { mount: p.get('mount') ?? '', key: p.get('key') ?? '' }
}

/** Inject the dev token as the session cookie BEFORE any WS handshake. */
function injectDevKey(key: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: dev-harness-only token injection; this route is DEV-gated and stripped from prod builds
  if (key) document.cookie = `cw-session=${key}; path=/; SameSite=Lax`
}

function HarnessChrome({ mount, hasKey }: { mount: string; hasKey: boolean }) {
  return (
    <header style={chromeStyle}>
      <strong>DEV HARNESS</strong>
      <span>
        mount=<code>{mount || '(none)'}</code>
      </span>
      {!hasKey && <span style={{ color: '#ffb454' }}>no key -- not authenticated</span>}
    </header>
  )
}

function MountBody({ mount }: { mount: string }) {
  const def = MOUNTS[mount]
  if (!def) {
    return (
      <p style={msgStyle}>
        Unknown mount <code>{mount || '(empty)'}</code>. Known mounts: {MOUNT_IDS.join(', ')}.
      </p>
    )
  }
  return (
    <Suspense fallback={<p style={msgStyle}>Loading {def.label}...</p>}>
      <def.Component />
    </Suspense>
  )
}

let injected = false

export default function DevHarnessRoute() {
  const { mount, key } = readParams()
  // Render-time injection runs before useWebSocket's connect effect, so the
  // cookie is in place for the handshake. Guarded to run once.
  if (!injected) {
    injectDevKey(key)
    injected = true
  }

  useWebSocket() // open a real broker session as the impersonated user

  return (
    <div style={pageStyle}>
      <HarnessChrome mount={mount} hasKey={!!key} />
      <ErrorSurface>
        <MountBody mount={mount} />
      </ErrorSurface>
    </div>
  )
}

const pageStyle: React.CSSProperties = { minHeight: '100vh', background: '#0b0b0d', color: '#e7e7ea' }
const chromeStyle: React.CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'center',
  padding: '8px 14px',
  borderBottom: '1px solid #222',
  font: '13px/1 ui-monospace, monospace',
}
const msgStyle: React.CSSProperties = { padding: 24, font: '14px/1.5 ui-monospace, monospace' }
