/**
 * Quick Task Modal - Ctrl+Shift+N shortcut
 * Creates a card at .rclaude/project/cards/<id>.md with `status: inbox`
 *
 * Render-only: the state machine is `use-quick-task.ts`. Tokens (grammar in
 * lib/cards/task-tokens.ts): `@epic` `!priority` `+depends-on` `&relates-to`
 * `/project` are EATEN on accept; `#tag` stays in the text and is parsed at
 * submit.
 *
 * Two submit keys: Enter files the card as captured, Cmd/Ctrl+Enter files the
 * same card tagged `needs-refine` for a later pass. Just a tag -- no spawn.
 */

import { AlertTriangle, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InputEditor } from './input-editor'
import { ProjectTag } from './project-tag'
import { QuickTaskChips } from './quick-task-chips'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Kbd, KbdGroup } from './ui/kbd'
import { useQuickTask } from './use-quick-task'
import { useProjectLook } from './wall/use-project-look'

function NoProjectWarning() {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-400">
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="text-[10px] font-mono">No project selected -- type /project to pick a board</span>
    </div>
  )
}

function Footer({ onSubmit, disabled }: { onSubmit: () => void; disabled: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-border shrink-0">
      <span className="text-[10px] text-muted-foreground flex items-center gap-1.5">
        <Kbd>↵</Kbd> add
        <span className="text-fg-faint">·</span>
        <KbdGroup>
          <Kbd>⇧</Kbd>
          <Kbd>↵</Kbd>
        </KbdGroup>{' '}
        newline
        <span className="text-fg-faint">·</span>
        {/* A keybinding nobody can see is a keybinding nobody uses. */}
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </KbdGroup>{' '}
        refine later
        <span className="text-fg-faint">·</span>
        <Kbd>Esc</Kbd> close
      </span>
      <Button type="button" variant="accent" size="sm" onClick={onSubmit} disabled={disabled}>
        Add
        <Kbd className="border-accent-foreground/25 bg-accent-foreground/15 text-accent-foreground">↵</Kbd>
      </Button>
    </div>
  )
}

export function QuickTaskModal() {
  const q = useQuickTask()

  // WHICH board is this landing on? A capture box that files into "the selected
  // conversation's project" is the thing you get wrong at 2am with six
  // conversations open -- and `/project` makes the target genuinely free, so
  // the header has to say it. Same icon and colour as everywhere else.
  const lookUp = useProjectLook()
  const look = q.targetProject ? lookUp(q.targetProject) : null

  return (
    <>
      {q.flash && !q.open && (
        <div className="fixed bottom-4 right-4 z-[100] px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 text-xs font-mono animate-pulse">
          Task created
        </div>
      )}
      <Dialog open={q.open} onOpenChange={q.onOpenChange}>
        <DialogContent className="max-w-lg max-h-[60vh] flex flex-col p-0 top-[15vh] translate-y-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
            <FileText className="size-4 text-accent" />
            <DialogTitle className="text-xs">Quick Task</DialogTitle>
            {look && (
              <ProjectTag
                name={look.projectName}
                icon={look.projectIcon}
                color={look.projectColor}
                className={`ml-auto text-[10px] font-mono font-bold uppercase tracking-wide ${
                  // A retarget is the one case where the header disagrees with
                  // the conversation behind the modal -- ring it so the switch
                  // is impossible to miss.
                  q.retargeted ? 'ring-1 ring-current/40 rounded px-1.5 py-0.5' : ''
                }`}
              />
            )}
          </div>
          {!q.targetProject && <NoProjectWarning />}
          <QuickTaskChips chips={q.chips} onRemove={q.onRemoveChip} />
          <div className="p-3 flex-1 min-h-0">
            <InputEditor
              value={q.text}
              onChange={q.setText}
              onSubmit={q.submit}
              onSubmitAlt={q.submitRefine}
              placeholder="Title, then body. /project @epic !priority +waits-on &see-also #tag"
              autoFocus
              inline
              taskTokens={q.taskTokens}
            />
          </div>
          <Footer onSubmit={q.submit} disabled={!q.text.trim() || !q.targetProject} />
        </DialogContent>
      </Dialog>
    </>
  )
}
