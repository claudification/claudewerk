export function openRenameModal(name?: string) {
  window.dispatchEvent(new CustomEvent('open-rename-modal', { detail: { name } }))
}
