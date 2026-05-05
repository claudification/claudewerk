export function EmptyState() {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      <pre className="text-xs" style={{ lineHeight: 0.95 }}>
        {`
┌───────────────────────────┐
│                           │
│   Select a session to     │
│   view details            │
│                           │
│   _                       │
│                           │
└───────────────────────────┘
`.trim()}
      </pre>
    </div>
  )
}
