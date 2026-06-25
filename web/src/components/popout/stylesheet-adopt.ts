/**
 * Mirror the parent document's stylesheets + theme vars into a popout window's
 * document, kept LIVE. The popout is a blank window.open('') -- it ships with no
 * CSS of its own, so we clone every <style>/<link rel=stylesheet> from the opener
 * head and copy the theme custom-properties (set inline on <html> by themes.ts).
 *
 * Stays in sync: Vite HMR injects fresh <style> nodes in dev, and a theme switch
 * rewrites the opener's <html> inline style -- a MutationObserver re-mirrors both
 * so the popout never drifts from the main tab. Returns a disconnect cleanup.
 */

const ADOPTED = 'data-popout-adopted'

export function adoptStyles(target: Document): () => void {
  const head = target.head

  const cloneSheets = () => {
    head.querySelectorAll(`[${ADOPTED}]`).forEach(n => {
      n.remove()
    })
    document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(node => {
      const clone = target.importNode(node, true) as HTMLElement
      clone.setAttribute(ADOPTED, '')
      head.appendChild(clone)
    })
  }

  // Theme vars (themes.ts setProperty) + any dark/light class live on <html>.
  const copyRoot = () => {
    target.documentElement.style.cssText = document.documentElement.style.cssText
    target.documentElement.className = document.documentElement.className
  }

  cloneSheets()
  copyRoot()

  const headObs = new MutationObserver(cloneSheets)
  headObs.observe(document.head, { childList: true })
  const rootObs = new MutationObserver(copyRoot)
  rootObs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })

  return () => {
    headObs.disconnect()
    rootObs.disconnect()
  }
}
