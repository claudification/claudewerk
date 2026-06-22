/**
 * Shared file upload with placeholder management.
 * Works with any editor (textarea, CodeMirror, etc.) via callbacks.
 *
 * @param conversationId - Optional conversation ID for CWD-scoped permission resolution.
 *   Without this, the server checks 'files' against '*' which fails for
 *   non-admin users whose grants are scoped to a specific CWD.
 */

// Image extensions, mirrored from markdown.tsx's renderer detection. Used only
// as a fallback when the File carries no MIME type (some paste/drop paths).
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'])

// Only images get markdown's `![](url)` embed syntax -- the renderer would draw
// a broken <img> for a PDF or text file. Everything else becomes a plain
// `[name](url)` link. MIME type is the authoritative signal for an uploaded
// File; extension is the fallback for the rare type-less paste/drop.
function isImageFile(file: File): boolean {
  if (file.type) return file.type.startsWith('image/')
  const m = (file.name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? IMAGE_EXT.has(m[1]) : false
}
/**
 * Bare upload: POST a File to the broker blob store and return its public URL.
 * The single chokepoint for `/api/files` from the browser -- reuse it, never
 * re-hand-roll the fetch (e.g. the Draw block spills its tldraw snapshot here).
 */
export async function uploadFile(file: File, conversationId?: string): Promise<{ url: string; filename: string }> {
  const formData = new FormData()
  formData.append('file', file, file.name || 'paste.png')
  const headers: Record<string, string> = {}
  if (conversationId) headers['x-conversation-id'] = conversationId
  const res = await fetch('/api/files', { method: 'POST', body: formData, headers })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  const { url, filename } = await res.json()
  return { url, filename }
}

export async function uploadFileWithPlaceholder(
  file: File,
  insert: (placeholder: string) => void,
  replace: (search: string, replacement: string) => void,
  conversationId?: string,
) {
  const isImage = isImageFile(file)
  const bang = isImage ? '!' : ''
  const placeholder = `${bang}[uploading ${file.name || 'file'}...]`
  insert(placeholder)
  try {
    const { url, filename } = await uploadFile(file, conversationId)
    replace(placeholder, `${bang}[${filename}](${url})`)
  } catch {
    replace(placeholder, '![upload failed]')
  }
}
