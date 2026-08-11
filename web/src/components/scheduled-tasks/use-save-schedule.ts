/**
 * Submit-and-report for the schedule editor.
 *
 * Small on purpose: the editor should not carry busy/error plumbing, and the
 * server's validation message is the one worth showing (it knows exactly which
 * field failed and why -- "cron: minute out of range" beats "invalid").
 */

import { useCallback, useState } from 'react'

export function useSaveSchedule({
  submit,
  onSaved,
}: {
  submit: () => Promise<{ ok: boolean; error?: string }>
  onSaved: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await submit()
      if (res.ok) onSaved()
      else setError(res.error ?? 'Could not save')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [submit, onSaved])

  return { save, saving, error }
}
