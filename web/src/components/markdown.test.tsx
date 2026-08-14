import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useMarkdownViewer } from '@/hooks/use-markdown-viewer'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { Markdown } from './markdown'

// beautiful-mermaid is lazy-imported and renders post-mount via useEffect; we
// only assert the synchronous parse output (placeholder vs streaming source vs
// inline SVG), so a light stub keeps the dynamic import from touching the DOM.
vi.mock('beautiful-mermaid', () => ({
  renderMermaidSVG: () => '<svg data-stub="mermaid" />',
}))

afterEach(cleanup)

function closedFence(src: string): string {
  return `\`\`\`mermaid\n${src}\n\`\`\``
}

describe('Markdown mermaid streaming flicker guard', () => {
  test('an unterminated (streaming) fence renders as plain source, NOT a mermaid placeholder', () => {
    // Mid-stream: the closing ``` has not arrived. Rendering the partial diagram
    // is what causes the enormous flicker, so we must keep it as a code block.
    const { container } = render(<Markdown>{'intro\n\n```mermaid\ngraph TD\n  A-->B'}</Markdown>)
    expect(container.querySelector('pre.mermaid')).toBeNull()
    const streaming = container.querySelector('code.mermaid-streaming')
    expect(streaming).not.toBeNull()
    // The raw source is preserved so the user still sees what is being drawn.
    expect(streaming?.textContent).toContain('graph TD')
    expect(streaming?.textContent).toContain('A-->B')
  })

  test('a closed fence renders the diagram (never a streaming code block)', async () => {
    const { container } = render(<Markdown>{closedFence('graph LR\n  X-->Y')}</Markdown>)
    // It must NOT be treated as still-streaming source...
    expect(container.querySelector('code.mermaid-streaming')).toBeNull()
    // ...and the post-mount pass replaces the placeholder with the rendered SVG.
    await waitFor(() => {
      expect(container.querySelector('.mermaid-container svg[data-stub="mermaid"]')).not.toBeNull()
    })
  })

  test('re-rendering identical source reuses the cached SVG inline (no placeholder flash)', async () => {
    // First render populates the mermaid cache via the post-mount pass.
    const src = closedFence('sequenceDiagram\n  A->>B: hi')
    const first = render(<Markdown>{src}</Markdown>)
    await waitFor(() => {
      expect(first.container.querySelector('.mermaid-container')).not.toBeNull()
    })
    cleanup()
    // Second render of the SAME diagram (cache warm) must emit the SVG inline
    // SYNCHRONOUSLY -- no `pre.mermaid` placeholder is ever mounted. This is the
    // path that kills streaming flicker once a diagram has rendered once.
    const second = render(<Markdown>{src}</Markdown>)
    expect(second.container.querySelector('pre.mermaid')).toBeNull()
    expect(second.container.querySelector('.mermaid-container svg[data-stub="mermaid"]')).not.toBeNull()
  })
})

describe('Markdown project-board card links', () => {
  const CARD = '[fix-thing](.rclaude/project/open/fix-thing.md)'

  beforeEach(() => {
    useConversationsStore.getState().setPendingTaskEdit(null)
    useMarkdownViewer.getState().close()
    useConversationsStore.setState({
      selectedConversationId: 'conv_1',
      conversationsById: { conv_1: { id: 'conv_1', project: 'claude://host//proj' } as never },
    })
  })

  test('a card path renders as a card link, a plain file path does not', () => {
    const { container } = render(<Markdown>{`${CARD}\n\n[ops](docs/ops.md)`}</Markdown>)
    const card = container.querySelector('a.file-link-card')
    expect(card?.getAttribute('data-file-path')).toBe('.rclaude/project/open/fix-thing.md')
    expect(card?.getAttribute('data-card-id')).toBe('fix-thing')
    // No `title`: the OS tooltip would race the hover card. The status glyph is
    // the affordance, painted once the provider answers.
    expect(card?.getAttribute('title')).toBeNull()
    expect(card?.querySelector('.card-glyph')).toBeTruthy()
    const plain = container.querySelector('a.file-link:not(.file-link-card)')
    expect(plain?.getAttribute('data-file-path')).toBe('docs/ops.md')
  })

  test('clicking a card link opens JUST the card -- never the file viewer, never the board', () => {
    const { container } = render(<Markdown>{CARD}</Markdown>)
    fireEvent.click(container.querySelector('a.file-link-card') as HTMLElement)
    // pendingTaskEdit drives the standalone card editor mounted beside the
    // transcript. The Kanban modal is not opened. The lane in the link (`open`)
    // is discarded -- the card is addressed by id, so the link cannot go stale.
    expect(useConversationsStore.getState().pendingTaskEdit).toEqual({ slug: 'fix-thing' })
    expect(useModalManagerStore.getState().records.kanban).toBeUndefined()
    expect(useMarkdownViewer.getState().current).toBeNull()
  })

  test('clicking a plain file link still opens the markdown viewer', () => {
    const { container } = render(<Markdown>{'[ops](docs/ops.md)'}</Markdown>)
    fireEvent.click(container.querySelector('a.file-link') as HTMLElement)
    expect(useMarkdownViewer.getState().current).toEqual({ projectUri: 'claude://host//proj', relPath: 'docs/ops.md' })
    expect(useConversationsStore.getState().pendingTaskEdit).toBeNull()
  })
})
