import type { KeyboardEvent, ReactNode, Ref } from 'react'

interface RenameFieldProps {
  id: string
  label: ReactNode
  value: string
  placeholder: string
  onChange: (value: string) => void
  onKeyDown: (e: KeyboardEvent) => void
  inputRef?: Ref<HTMLInputElement>
}

/** One labeled text input of the rename modal (name / description). */
export function RenameField({ id, label, value, placeholder, onChange, onKeyDown, inputRef }: RenameFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        className="w-full bg-muted/50 border border-border text-sm font-mono px-2 py-1.5 outline-none text-foreground focus:border-accent transition-colors"
        placeholder={placeholder}
      />
    </div>
  )
}
