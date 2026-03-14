/**
 * CopyMenu - Copy button with format options.
 * Desktop: click = copy markdown, right-click = format picker (Radix ContextMenu).
 * Mobile: tap = format picker (Radix DropdownMenu).
 */

import { Check, Copy } from 'lucide-react'
import { Marked } from 'marked'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import { useState } from 'react'
import { cn, haptic, isMobileViewport } from '@/lib/utils'

const marked = new Marked()

type CopyFormat = 'rich' | 'markdown' | 'plain'

const FORMAT_OPTIONS: Array<{ key: CopyFormat; label: string; desc: string }> = [
  { key: 'rich', label: 'Rich Text', desc: 'Bold, bullets, links' },
  { key: 'markdown', label: 'Markdown', desc: 'Raw source' },
  { key: 'plain', label: 'Plain Text', desc: 'No formatting' },
]

function stripHtml(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || div.innerText || ''
}

function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string
}

async function copyAs(text: string, format: CopyFormat) {
  switch (format) {
    case 'markdown':
      await navigator.clipboard.writeText(text)
      break
    case 'plain': {
      const html = markdownToHtml(text)
      await navigator.clipboard.writeText(stripHtml(html))
      break
    }
    case 'rich': {
      const html = markdownToHtml(text)
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([stripHtml(html)], { type: 'text/plain' }),
          }),
        ])
      } catch {
        await navigator.clipboard.writeText(stripHtml(html))
      }
      break
    }
  }
}

// Shared menu items used by both ContextMenu and DropdownMenu
const menuContentClass =
  'min-w-[170px] bg-popover border border-border rounded-lg shadow-xl py-1 z-[100] animate-in fade-in zoom-in-95 duration-100'
const menuLabelClass = 'px-3 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider font-bold'
const menuSepClass = 'h-px bg-border my-1'
const menuItemClass =
  'px-3 py-2.5 sm:py-2 hover:bg-accent/50 active:bg-accent focus:bg-accent/50 outline-none transition-colors cursor-pointer flex flex-col gap-0.5'

interface CopyMenuProps {
  text: string
  className?: string
  iconClassName?: string
}

export function CopyMenu({ text, className, iconClassName = 'w-3 h-3' }: CopyMenuProps) {
  const [copied, setCopied] = useState(false)

  function flashCopied() {
    setCopied(true)
    haptic('success')
    setTimeout(() => setCopied(false), 1500)
  }

  function handleSelect(format: CopyFormat) {
    haptic('tap')
    copyAs(text, format).then(flashCopied)
  }

  function handleOpen() {
    haptic('double')
    window.getSelection()?.removeAllRanges()
  }

  const buttonClass = cn('text-muted-foreground/40 hover:text-muted-foreground transition-colors p-0.5', className)
  const icon = copied ? <Check className={cn(iconClassName, 'text-emerald-400')} /> : <Copy className={iconClassName} />

  // Mobile: tap opens dropdown menu with format options
  if (isMobileViewport()) {
    return (
      <DropdownMenu.Root onOpenChange={open => open && handleOpen()}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className={buttonClass} title="Copy options">
            {icon}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={menuContentClass} align="end" sideOffset={5}>
            <DropdownMenu.Label className={menuLabelClass}>Copy as</DropdownMenu.Label>
            <DropdownMenu.Separator className={menuSepClass} />
            {FORMAT_OPTIONS.map(opt => (
              <DropdownMenu.Item key={opt.key} className={menuItemClass} onSelect={() => handleSelect(opt.key)}>
                <span className="text-sm font-medium text-foreground">{opt.label}</span>
                <span className="text-[11px] text-muted-foreground">{opt.desc}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    )
  }

  // Desktop: click = copy markdown, right-click = format picker
  return (
    <ContextMenu.Root onOpenChange={open => open && handleOpen()}>
      <ContextMenu.Trigger asChild>
        <button
          type="button"
          className={buttonClass}
          title="Copy (right-click for options)"
          onClick={e => {
            e.stopPropagation()
            haptic('tap')
            navigator.clipboard.writeText(text).then(flashCopied)
          }}
        >
          {icon}
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClass} alignOffset={5}>
          <ContextMenu.Label className={menuLabelClass}>Copy as</ContextMenu.Label>
          <ContextMenu.Separator className={menuSepClass} />
          {FORMAT_OPTIONS.map(opt => (
            <ContextMenu.Item key={opt.key} className={menuItemClass} onSelect={() => handleSelect(opt.key)}>
              <span className="text-xs font-medium text-foreground">{opt.label}</span>
              <span className="text-[10px] text-muted-foreground">{opt.desc}</span>
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
