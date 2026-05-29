/** Typed section cards (features/bugs/fixes/decisions/dead-ends/gotchas/incidents)
 *  rendered from the structured frontmatter, plus open-questions + meta chips. */

import type { RecapItem, RecapMetadata } from '@shared/protocol'
import { ChipRow, Citations, MetaList } from './recap-bits'

const SECTIONS: Array<{ key: keyof RecapMetadata; title: string }> = [
  { key: 'features', title: 'Features shipped' },
  { key: 'bugs', title: 'Bug fixes' },
  { key: 'fixes', title: 'Refactors / cleanup' },
  { key: 'decisions', title: 'Decisions' },
  { key: 'dead_ends', title: 'Dead ends -- do NOT retry' },
  { key: 'gotchas', title: 'Gotchas' },
  { key: 'incidents', title: 'Incidents' },
]

function ItemCard({ item, onOpenConversation }: { item: RecapItem; onOpenConversation?: (id: string) => void }) {
  return (
    // intentional visual treatment for the per-section card stack (UI design call)
    // react-doctor-disable-next-line react-doctor/no-side-tab-border
    // intentional visual treatment for the per-section card stack (UI design call)
    // react-doctor-disable-next-line react-doctor/no-side-tab-border
    <li className="rounded border-l-2 border-border bg-muted/20 px-2.5 py-1.5">
      <div className="text-sm leading-snug">
        {item.title}
        <Citations item={item} onOpenConversation={onOpenConversation} />
      </div>
      {item.detail && <div className="mt-0.5 text-xs text-muted-foreground">{item.detail}</div>}
    </li>
  )
}

function Section({
  title,
  items,
  onOpenConversation,
}: {
  title: string
  items: RecapItem[]
  onOpenConversation?: (id: string) => void
}) {
  if (!items.length) return null
  return (
    <div>
      <h3 className="mb-1.5 text-sm font-semibold">
        {title} <span className="text-muted-foreground">{items.length}</span>
      </h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static recap list, rendered once, never reordered
          <ItemCard key={`${it.title}-${i}`} item={it} onOpenConversation={onOpenConversation} />
        ))}
      </ul>
    </div>
  )
}

function OpenQuestions({ questions }: { questions: string[] }) {
  if (!questions.length) return null
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
      <h3 className="mb-1.5 text-sm font-semibold text-warning">Open questions / unresolved</h3>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-sm">
        {questions.map((q, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static recap list, rendered once, never reordered
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key
          <li key={`${q.slice(0, 24)}-${i}`}>{q}</li>
        ))}
      </ul>
    </div>
  )
}

/** Pillar F: the retrospective block -- rendered only when the recap was created
 *  with retrospect:true (the three fields are absent otherwise). */
function Retrospect({
  metadata,
  onOpenConversation,
}: {
  metadata: RecapMetadata
  onOpenConversation?: (id: string) => void
}) {
  const well = metadata.went_well ?? []
  const badly = metadata.went_badly ?? []
  const recs = metadata.recommendations ?? []
  if (!well.length && !badly.length && !recs.length) return null
  return (
    <div className="flex flex-col gap-3 rounded-md border border-accent/40 bg-accent/5 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Retrospective</div>
      <Section title="What went well" items={well} onOpenConversation={onOpenConversation} />
      <Section title="What went badly" items={badly} onOpenConversation={onOpenConversation} />
      <Section title="Recommendations" items={recs} onOpenConversation={onOpenConversation} />
    </div>
  )
}

export function RecapSections({
  metadata,
  onOpenConversation,
}: {
  metadata: RecapMetadata
  onOpenConversation?: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {SECTIONS.map(s => (
        <Section
          key={s.key}
          title={s.title}
          items={metadata[s.key] as RecapItem[]}
          onOpenConversation={onOpenConversation}
        />
      ))}
      <Retrospect metadata={metadata} onOpenConversation={onOpenConversation} />
      <OpenQuestions questions={metadata.open_questions} />
      {/* Sentence-shaped fields render as bullet lists; tag-shaped fields as
          hash-colored chips so a dense cloud stays scannable. */}
      <div className="flex flex-col gap-3">
        <MetaList label="goals" items={metadata.goals} />
        <MetaList label="discoveries" items={metadata.discoveries} />
        <MetaList label="side effects" items={metadata.side_effects} tone="warning" />
        <div className="flex flex-col gap-1.5">
          <ChipRow label="hashtags" items={metadata.hashtags} hash />
          <ChipRow label="keywords" items={metadata.keywords} hash />
          <ChipRow label="people" items={metadata.stakeholders} />
        </div>
      </div>
    </div>
  )
}
