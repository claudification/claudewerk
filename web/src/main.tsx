// If the previous page load crashed (error boundary fired), nuke SW + caches
// so the next load gets fresh code from the network instead of broken cache.
// This MUST run before anything else -- a broken cached bundle could crash again.
// 2s deadline guarantees reload even if cache/SW ops hang.
if (localStorage.getItem('sw-crash-detected')) {
  localStorage.removeItem('sw-crash-detected')
  const go = () => window.location.replace(`${location.origin}/?_cb=${Date.now()}${location.hash}`)
  const deadline = setTimeout(go, 2000)
  ;(async () => {
    try {
      const regs = await navigator.serviceWorker?.getRegistrations()
      if (regs) await Promise.allSettled(regs.map(r => r.unregister()))
    } catch {}
    try {
      const keys = await caches?.keys()
      if (keys) await Promise.allSettled(keys.map(k => caches.delete(k)))
    } catch {}
    clearTimeout(deadline)
    go()
  })().catch(go)
}

import React, { lazy, Suspense, useCallback, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app'
import { installChunkLoadLog } from './lib/chunk-load-log'
import { installLogCapture } from './lib/debug-log'
import { installLongTaskLog } from './lib/longtask-log'
import { installTabVisibility } from './lib/tab-visibility'

// Capture console output into ring buffer before anything else runs
installLogCapture()
installChunkLoadLog()
installLongTaskLog()
// Freeze infinite CSS animations while the tab is hidden (composite/layer win)
installTabVisibility()

import { ErrorBoundary } from './components/error-boundary'
import '@fontsource/geist/400.css'
import '@fontsource/geist/500.css'
import '@fontsource/geist/600.css'
import '@fontsource/geist-mono/400.css'
// Terminal bold/italic faces. Without the real 700 face, the DOM renderer's
// bold text (table headers, TUI emphasis) falls back to browser FAUX-bold,
// which is wider than the monospace cell -- every row with bold drifts right
// and tables/box-drawing go ragged (measured: +15px -> 0.6px once 700 loads).
// font-display:swap means these only download when styled text is first drawn.
import '@fontsource/geist-mono/700.css'
import '@fontsource/geist-mono/400-italic.css'
import '@fontsource/geist-mono/700-italic.css'
import './styles/globals.css'
import { setRemountTrigger } from './lib/remount'
import { loadAndApplyTheme } from './lib/themes'

loadAndApplyTheme()

function Root() {
  const [gen, setGen] = useState(0)
  const [mounted, setMounted] = useState(true)

  const doRemount = useCallback(() => {
    const t0 = performance.now()
    console.log('[remount] tearing down App tree...')
    setMounted(false)

    requestAnimationFrame(() => {
      const teardown = performance.now() - t0
      console.log(`[remount] teardown took ${teardown.toFixed(1)}ms, re-mounting...`)
      setGen(g => g + 1)
      setMounted(true)

      requestAnimationFrame(() => {
        const total = performance.now() - t0
        console.log(
          `[remount] full cycle: ${total.toFixed(1)}ms (teardown=${teardown.toFixed(1)}ms, mount=${(total - teardown).toFixed(1)}ms)`,
        )
        window.dispatchEvent(
          new CustomEvent('rclaude-toast', {
            detail: {
              title: 'App remounted',
              body: `${total.toFixed(0)}ms total (${teardown.toFixed(0)}ms tear + ${(total - teardown).toFixed(0)}ms mount)`,
              variant: 'info',
            },
          }),
        )
      })
    })
  }, [])

  setRemountTrigger(doRemount)

  return mounted ? <App key={gen} /> : null
}

// A drawing opens in its OWN lightweight window (/canvas/:id, via window.open):
// render JUST the canvas surface, NOT the full app shell. Lazy so the canvas
// chunk (Excalidraw) never loads for the main app.
const CanvasWindow = lazy(() => import('./components/canvas/canvas-window').then(m => ({ default: m.CanvasWindow })))
const isCanvasWindow = window.location.pathname.startsWith('/canvas/')

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isCanvasWindow ? (
        <Suspense fallback={null}>
          <CanvasWindow />
        </Suspense>
      ) : (
        <Root />
      )}
    </ErrorBoundary>
  </React.StrictMode>,
)

// Register service worker for caching + push notifications
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js')
    .then(reg => {
      // Check for SW updates immediately on load + every hour
      reg.update().catch(() => {})
      setInterval(() => reg.update().catch(() => {}), 10 * 60 * 1000)
    })
    .catch(() => {})
}
