/**
 * mic-error - turn a getUserMedia rejection into a sentence the user can act on.
 *
 * getUserMedia rejects with a DOMException whose `.message` is spec prose, not
 * advice. WebKit's NotAllowedError text in particular ("The request is not
 * allowed by the user agent or the platform in the current context, possibly
 * because the user denied permission.") is the worst of them: it is long, it
 * hedges, and it blames the user for something the platform did. Rendering it
 * raw cost a full remote-debugging session on 2026-08-12 -- see the iPad
 * incident note in `use-mic-permission.ts`.
 *
 * Branch on `.name`, never on `.message`: the name is the stable contract, the
 * message is vendor prose that differs per browser and per version.
 */

/** A Home Screen / installed web app rather than a browser tab. */
function isStandaloneApp(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  const displayMode = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches === true
  return iosStandalone || displayMode
}

/**
 * iOS/iPadOS drops a standalone web app's mic grant on every reload, and the
 * app has no address bar to re-grant from -- so a denial there needs different
 * advice from a denial in a tab. Touch is the iOS tell: iPadOS Safari reports
 * a Macintosh user agent, so the UA string cannot be trusted for this.
 */
function deniedText(): string {
  if (isStandaloneApp() && navigator.maxTouchPoints > 0) {
    return 'Mic blocked by iOS. Open this in Safari, or re-add the Home Screen app.'
  }
  return 'Microphone permission denied. Allow mic access and try again.'
}

const MIC_ERROR_TEXT: Record<string, () => string> = {
  NotAllowedError: deniedText,
  SecurityError: deniedText,
  NotFoundError: () => 'No microphone found.',
  NotReadableError: () => 'Microphone is in use by another app.',
  OverconstrainedError: () => 'The selected microphone is unavailable.',
  AbortError: () => 'Microphone access was interrupted.',
}

/**
 * A user-facing line for any mic failure. A plain `Error` we threw ourselves
 * (the acquire timeout) keeps its own wording -- only DOMException names are
 * translated.
 */
export function describeMicError(err: unknown): string {
  if (!(err instanceof Error)) return 'Microphone unavailable.'
  const mapped = MIC_ERROR_TEXT[err.name]
  if (mapped) return mapped()
  return err.message || 'Microphone unavailable.'
}
