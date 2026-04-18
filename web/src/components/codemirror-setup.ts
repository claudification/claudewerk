/**
 * CM6 extension factories shared between the file editor and the project
 * board's task-body markdown editor. Lazy-loaded by each consumer so the
 * language packs and themes only ship when someone actually opens an editor.
 *
 * The InputEditor has its own extensions in
 * `input-editor/backends/codemirror/extensions.ts` because its theming and
 * keymap differ (compact, submit-on-Enter, autocomplete).
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { bracketMatching, HighlightStyle, type LanguageSupport, syntaxTree } from '@codemirror/language'
import { type Extension, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { highlightTree, tags } from '@lezer/highlight'

// ---------------------------------------------------------------------------
// Tokyo Night highlight (full set)
// ---------------------------------------------------------------------------

const tokyoNightHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: '#7aa2f7', fontWeight: 'bold', fontSize: '1.3em' },
  { tag: tags.heading2, color: '#7aa2f7', fontWeight: 'bold', fontSize: '1.2em' },
  { tag: tags.heading3, color: '#7aa2f7', fontWeight: 'bold', fontSize: '1.1em' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: '#7aa2f7', fontWeight: 'bold' },
  { tag: tags.strong, color: '#c0caf5', fontWeight: 'bold' },
  { tag: tags.emphasis, color: '#c0caf5', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: '#565f89' },
  { tag: tags.link, color: '#73daca', textDecoration: 'underline' },
  { tag: tags.url, color: '#73daca' },
  { tag: tags.monospace, color: '#89ddff' },
  { tag: tags.processingInstruction, color: '#565f89' },
  { tag: tags.quote, color: '#9ece6a' },
  { tag: tags.list, color: '#e0af68' },
  { tag: tags.string, color: '#9ece6a' },
  { tag: tags.labelName, color: '#bb9af7' },
  { tag: tags.content, color: '#a9b1d6' },
  { tag: tags.comment, color: '#565f89', fontStyle: 'italic' },
  { tag: tags.escape, color: '#bb9af7' },
  { tag: tags.character, color: '#bb9af7' },
  { tag: tags.keyword, color: '#bb9af7' },
  { tag: tags.operator, color: '#89ddff' },
  { tag: tags.number, color: '#ff9e64' },
  { tag: tags.function(tags.variableName), color: '#7aa2f7' },
  { tag: tags.variableName, color: '#c0caf5' },
  { tag: tags.typeName, color: '#2ac3de' },
  { tag: tags.propertyName, color: '#73daca' },
  { tag: tags.contentSeparator, color: '#565f89' },
])

/**
 * Direct highlight plugin -- paints Tokyo Night decorations via highlightTree().
 * Bypasses CM6's syntaxHighlighting facet, which had stale-style bugs in our
 * original integration.
 */
function makeDirectHighlightPlugin() {
  const markCache: Record<string, Decoration> = Object.create(null)
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }
      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>()
        const tree = syntaxTree(view.state)
        for (const { from, to } of view.visibleRanges) {
          highlightTree(
            tree,
            tokyoNightHighlight,
            (hFrom, hTo, cls) => {
              if (!markCache[cls]) markCache[cls] = Decoration.mark({ class: cls })
              builder.add(hFrom, hTo, markCache[cls])
            },
            from,
            to,
          )
        }
        return builder.finish()
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          this.decorations = this.build(u.view)
        }
      }
    },
    { decorations: v => v.decorations },
  )
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

const fileEditorTheme = EditorView.theme(
  {
    '&': {
      fontSize: '13px',
      fontFamily: '"Geist Mono", "JetBrains Mono", monospace',
      height: '100%',
      backgroundColor: '#1a1b26',
    },
    '.cm-content': { padding: '8px 0', caretColor: '#7aa2f7', color: '#a9b1d6' },
    '.cm-cursor': { borderLeftColor: '#7aa2f7' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: '#3b4261',
      borderRight: '1px solid rgba(122, 162, 247, 0.1)',
    },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(122, 162, 247, 0.05)', color: '#737aa2' },
    '.cm-activeLine': { backgroundColor: 'rgba(122, 162, 247, 0.05)' },
    '.cm-selectionBackground': { backgroundColor: 'rgba(122, 162, 247, 0.2) !important' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(122, 162, 247, 0.3) !important' },
    '.cm-scroller': { overflow: 'auto' },
  },
  { dark: true },
)

const markdownEditorTheme = EditorView.theme(
  {
    '&': {
      fontSize: '13px',
      fontFamily: '"Geist Mono", "JetBrains Mono", monospace',
      backgroundColor: 'transparent',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': { padding: '0', caretColor: '#7aa2f7', color: '#a9b1d6', minHeight: '200px' },
    '.cm-cursor': { borderLeftColor: '#7aa2f7' },
    '.cm-selectionBackground': { backgroundColor: 'rgba(122, 162, 247, 0.2) !important' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(122, 162, 247, 0.3) !important' },
    '.cm-scroller': { overflow: 'visible', lineHeight: '1.625' },
  },
  { dark: true },
)

// ---------------------------------------------------------------------------
// Language resolution
// ---------------------------------------------------------------------------

function langFromPath(filePath: string | undefined): LanguageSupport | Extension {
  if (!filePath) return markdown()
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: ext === 'tsx' })
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'json':
    case 'jsonl':
      return json()
    case 'css':
      return css()
    case 'html':
    case 'htm':
    case 'svg':
      return html()
    case 'py':
      return python()
    default:
      return markdown()
  }
}

// ---------------------------------------------------------------------------
// Public: extension array factories (use with <CodeMirror extensions={...} />)
// ---------------------------------------------------------------------------

/** Extensions for the full file editor: line numbers, active-line, language-aware. */
export function buildFileEditorExtensions(filePath?: string): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    bracketMatching(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    langFromPath(filePath),
    fileEditorTheme,
    makeDirectHighlightPlugin(),
    // biome-ignore lint/style/noNonNullAssertion: module is always defined after HighlightStyle.define
    EditorView.styleModule.of(tokyoNightHighlight.module!),
    EditorView.lineWrapping,
  ]
}

/** Extensions for the markdown-only task-body editor: no gutters, auto-height. */
export function buildMarkdownBodyExtensions(): Extension[] {
  return [
    drawSelection(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown(),
    markdownEditorTheme,
    makeDirectHighlightPlugin(),
    // biome-ignore lint/style/noNonNullAssertion: module is always defined after HighlightStyle.define
    EditorView.styleModule.of(tokyoNightHighlight.module!),
    EditorView.lineWrapping,
  ]
}
