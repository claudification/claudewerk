/**
 * DataModel block — renders a model/table name and its fields as a compact
 * schema table. Per-field change status colors the row.
 */
import { cn } from '@/lib/utils'
import type { DataModelComponent } from '../types'
import { STATUS_TEXT } from './block-status'

export function DataModelBlock({ name, fields }: Pick<DataModelComponent, 'name' | 'fields'>) {
  return (
    <div className="rounded border border-border/30 overflow-hidden">
      <div className="px-3 py-1.5 bg-muted/40 border-b border-border/30 text-xs font-semibold">{name}</div>
      <table className="w-full text-xs">
        <tbody>
          {fields.map((field, i) => (
            <tr
              // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
              // biome-ignore lint/suspicious/noArrayIndexKey: schema rows are positional
              key={i}
              className="border-b border-border/20 last:border-0"
            >
              <td
                className={cn('px-3 py-1.5 font-mono font-medium align-top', field.status && STATUS_TEXT[field.status])}
              >
                {field.name}
              </td>
              <td className="px-3 py-1.5 font-mono text-muted-foreground align-top">{field.type}</td>
              <td className="px-3 py-1.5 text-muted-foreground/70 align-top">{field.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
