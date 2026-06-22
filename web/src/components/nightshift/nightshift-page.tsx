import { useConversationsStore } from '@/hooks/use-conversations'
import { useNightshift } from '@/hooks/use-nightshift'
import { NightshiftReport } from './nightshift-report'

function BackButton() {
  return (
    <button
      type="button"
      onClick={() => {
        window.location.hash = ''
      }}
      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      &larr; back
    </button>
  )
}

export function NightshiftPage() {
  const projectUri = useConversationsStore(s => s.selectedProjectUri)
  const { snapshot, loading, error, refetch } = useNightshift(projectUri)

  if (!projectUri) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>Open a project to see its night report.</p>
        <BackButton />
      </div>
    )
  }

  if (loading && snapshot === undefined) {
    return (
      <div className="fixed inset-0 flex items-center justify-center text-muted-foreground">
        Loading night report...
      </div>
    )
  }

  if (error) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3">
        <p className="text-red-400 text-sm">{error}</p>
        <button type="button" onClick={refetch} className="text-xs text-muted-foreground hover:text-foreground">
          retry
        </button>
        <BackButton />
      </div>
    )
  }

  return (
    <div className="fixed inset-0 overflow-y-auto bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        <div className="flex items-center justify-between">
          <BackButton />
          <span className="text-xs font-mono text-muted-foreground">NIGHTSHIFT</span>
        </div>

        {!snapshot ? (
          <p className="text-muted-foreground text-sm">No nightshift runs yet for this project.</p>
        ) : (
          <NightshiftReport snapshot={snapshot} />
        )}
      </div>
    </div>
  )
}
