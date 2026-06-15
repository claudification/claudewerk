import { Pencil } from 'lucide-react'
import type { RenameModalState } from '@/hooks/use-rename-modal'
import { RenameField } from './rename-field'
import { RenameFooter } from './rename-footer'
import { RenameSuggestion } from './rename-suggestion'
import { DialogContent, DialogTitle } from './ui/dialog'

/** The inner content of the rename modal -- header, the two fields, the
 *  suggestion chip, and the footer. Split from RenameModal so neither function
 *  carries the whole markup. */
export function RenameDialogBody({ state }: { state: RenameModalState }) {
  const {
    name,
    description,
    headerLabel,
    suggestion,
    showSuggestion,
    requestingName,
    showFetchHint,
    nameRef,
    setName,
    setDescription,
    handleSubmit,
    applySuggestion,
    handleKeyDown,
  } = state

  return (
    <DialogContent className="max-w-md flex flex-col p-0 top-[20vh] translate-y-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <Pencil className="size-4 text-accent" />
        <DialogTitle className="text-xs">Rename conversation</DialogTitle>
        <span className="text-[10px] text-muted-foreground ml-1 truncate max-w-[200px]">{headerLabel}</span>
      </div>

      <div className="p-3 flex flex-col gap-3">
        <RenameField
          id="rename-name"
          label="Name"
          value={name}
          placeholder="conversation name"
          onChange={setName}
          onKeyDown={handleKeyDown}
          inputRef={nameRef}
        />
        {showSuggestion && <RenameSuggestion suggestion={suggestion} onApply={() => applySuggestion(suggestion)} />}
        <RenameField
          id="rename-desc"
          label={
            <>
              Description <span className="text-muted-foreground/50">(optional)</span>
            </>
          }
          value={description}
          placeholder="short description"
          onChange={setDescription}
          onKeyDown={handleKeyDown}
        />
      </div>

      <RenameFooter
        showSuggestion={showSuggestion}
        requestingName={requestingName}
        showFetchHint={showFetchHint}
        onSubmit={handleSubmit}
      />
    </DialogContent>
  )
}
