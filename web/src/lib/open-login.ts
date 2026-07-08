/**
 * Fire the `open-login` event that opens the Login modal for a conversation.
 * Shared by all three triggers (401 hint, `/login`, command palette) so none of
 * them re-hardcodes the event name.
 */
export function openLogin(conversationId: string): void {
  window.dispatchEvent(new CustomEvent('open-login', { detail: { conversationId } }))
}
