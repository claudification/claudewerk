/**
 * Lightweight markdown syntax highlighter for the textarea overlay.
 *
 * Colors syntax markers (fences, backticks, bold, italic, headings, etc.)
 * without rendering the markdown. The result is injected via
 * dangerouslySetInnerHTML into a div layered behind the transparent textarea.
 */
export function highlightMarkdown(text: string, enableEffortKeywords = false): string {
  if (!text) return '\n'

  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Fenced code blocks (``` ... ```)
  html = html.replace(
    /(```(\w*)\n?)([\s\S]*?)(```)/g,
    '<span class="text-cyan-300">$1</span><span class="text-cyan-400/70">$3</span><span class="text-cyan-300">$4</span>',
  )

  // Inline code (`...`)
  html = html.replace(/(`[^`\n]+`)/g, '<span class="text-cyan-400">$1</span>')

  // Bold, italic, headings -- skip already-highlighted code spans
  html = html
    .split(/(<span class="text-cyan-[^"]*">[\s\S]*?<\/span>)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part
      let p = part.replace(/(\*\*[^*]+\*\*)/g, '<span class="text-foreground">$1</span>')
      p = p.replace(/(?<!\*)(\*[^*\n]+\*)(?!\*)/g, '<span class="text-foreground/70">$1</span>')
      p = p.replace(/(?<!_)(_[^_\n]+_)(?!_)/g, '<span class="text-foreground/70">$1</span>')
      p = p.replace(/^(#{1,6}\s.*)$/gm, '<span class="text-accent">$1</span>')
      return p
    })
    .join('')

  // Blockquotes
  html = html.replace(/^(&gt;\s?.*)$/gm, '<span class="text-muted-foreground">$1</span>')

  // List items
  html = html.replace(/^(\s*[-*]\s)/gm, '<span class="text-muted-foreground">$1</span>')

  // Links
  html = html.replace(/(\[[^\]]*\]\([^)]*\))/g, '<span class="text-accent underline">$1</span>')

  // Effort keywords (prompt input only)
  if (enableEffortKeywords) {
    html = html.replace(
      /\b(ultrathink)\b/gi,
      '<span class="text-orange-400 underline decoration-orange-400/40 decoration-2 underline-offset-2">$1</span>',
    )
  }

  if (!html.endsWith('\n')) html += '\n'

  return html
}
