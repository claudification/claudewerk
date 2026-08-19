import { lazy, Suspense, useState } from 'react'

import { Button } from '@/components/ui/button'

/* LAZY LOAD covenant: the playground pulls in the preset table and the slider
   UI, none of which the hot path needs. It travels in its own chunk. */
const ThemePlaygroundModal = lazy(() =>
  import('../theme-playground/theme-playground-modal').then(m => ({ default: m.ThemePlaygroundModal })),
)

export function ThemePlaygroundItem() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
        Open playground
      </Button>
      {open && (
        <Suspense fallback={null}>
          <ThemePlaygroundModal open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  )
}
