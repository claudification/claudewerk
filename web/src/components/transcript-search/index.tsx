import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { SyntaxHints } from './bits'
import { ColdBar } from './cold-bar'
import { ResultsList } from './results-list'
import { SearchHeader, ShortcutBar } from './search-header'
import { useSearchDialog } from './use-search-dialog'

export function TranscriptSearch() {
  const {
    open,
    setOpen,
    activeIndex,
    setActiveIndex,
    hot,
    cold,
    coldHits,
    inputRef,
    handleKeyDown,
    focusedTitle,
    goTo,
    changeQuery,
  } = useSearchDialog()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-w-2xl p-0 gap-0 overflow-hidden bg-surface-inset border-primary/20"
        aria-label="Search transcripts"
      >
        <DialogTitle className="sr-only">Search transcripts</DialogTitle>

        <SearchHeader
          inputRef={inputRef}
          query={hot.query}
          mode={hot.mode}
          focusedTitle={focusedTitle}
          loading={hot.loading}
          total={hot.total}
          sort={hot.sort}
          onQueryChange={changeQuery}
          onKeyDown={handleKeyDown}
          onDrillOut={hot.drillOut}
          onSortChange={hot.changeSort}
        />

        <div className="overflow-y-auto max-h-[60vh] min-h-[200px]">
          <ResultsList
            mode={hot.mode}
            query={hot.query}
            loading={hot.loading}
            conversationHits={hot.conversationHits}
            snippetHits={hot.snippetHits}
            coldHits={coldHits}
            activeIndex={activeIndex}
            onActivate={setActiveIndex}
            onDrillInto={hot.drillInto}
            onGoTo={goTo}
          />
        </div>

        <ColdBar
          plan={cold.plan}
          result={cold.result}
          running={cold.running}
          error={cold.error}
          includeToolOutput={cold.includeToolOutput}
          canRun={hot.query.trim().length > 0}
          onRun={() => cold.run(hot.query)}
          onToggleToolOutput={cold.toggleToolOutput}
        />
        <SyntaxHints />
        <ShortcutBar mode={hot.mode} />
      </DialogContent>
    </Dialog>
  )
}
