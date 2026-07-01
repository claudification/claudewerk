/**
 * Shared helpers for dialog input fields — the select-toggle logic and the
 * field label header are identical across Options and ImagePicker, so they live
 * here instead of being duplicated in each.
 */
import { Markdown } from '@/components/markdown'
import { haptic } from '@/lib/utils'

interface SelectForm {
  values: Record<string, unknown>
  setValue: (id: string, value: unknown) => void
}

// react-doctor:only-export-components -- this is a shared helpers module, not a
// component file; applySelect + FieldLabel are both consumed by dialog-renderer.
/** Toggle a value into a single- or multi-select form field. */
export function applySelect(form: SelectForm, id: string, value: string, multi?: boolean): void {
  haptic('tap')
  if (multi) {
    const arr = (Array.isArray(form.values[id]) ? form.values[id] : []) as string[]
    form.setValue(id, arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value])
  } else {
    form.setValue(id, value)
  }
}

export function FieldLabel({ label }: { label?: string }) {
  if (!label) return null
  return (
    <div className="text-sm font-medium text-foreground/80">
      <Markdown inline>{label}</Markdown>
    </div>
  )
}
