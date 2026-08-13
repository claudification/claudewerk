/**
 * The one way to raise a toast from outside a component.
 *
 * `ToastContainer` listens for the `rclaude-toast` CustomEvent, so anything can
 * raise one -- hooks and plain modules included, which is the point: a failure
 * discovered in a promise chain has no JSX to render an error into.
 */

export type ToastVariant = 'warning' | 'error' | 'info' | 'success'

export interface ToastInput {
  title: string
  body: string
  variant?: ToastVariant
}

export function showToast({ title, body, variant = 'warning' }: ToastInput): void {
  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail: { title, body, variant } }))
}
