/** "View past recaps..." -- opens the recap-history modal (Phase 10). */
export function openRecapHistory(projectUri?: string) {
  window.dispatchEvent(new CustomEvent('rclaude-recap-history-open', { detail: { projectUri } }))
}
