/**
 * Shared file upload with placeholder management.
 * Works with any editor (textarea, CodeMirror, etc.) via callbacks.
 */
export async function uploadFileWithPlaceholder(
  file: File,
  insert: (placeholder: string) => void,
  replace: (search: string, replacement: string) => void,
) {
  const placeholder = `![uploading ${file.name || 'file'}...]`
  insert(placeholder)
  try {
    const formData = new FormData()
    formData.append('file', file, file.name || 'paste.png')
    const res = await fetch('/api/files', { method: 'POST', body: formData })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    const { url, filename } = await res.json()
    replace(placeholder, `![${filename}](${url})`)
  } catch {
    replace(placeholder, '![upload failed]')
  }
}
