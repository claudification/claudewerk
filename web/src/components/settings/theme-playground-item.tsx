import { Button } from '@/components/ui/button'

/**
 * The playground mounts once in `app.tsx`, because it is reachable from BOTH
 * the command palette and this settings row. Holding it here with local state
 * would give the two entry points separate instances -- and separate unsaved
 * slider positions.
 */
export function ThemePlaygroundItem() {
  return (
    <Button variant="outline" size="xs" onClick={() => window.dispatchEvent(new Event('open-theme-playground'))}>
      Open playground
    </Button>
  )
}
