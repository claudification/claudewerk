export interface ConversationHit {
  conversationId: string
  title: string
  project: string
  hitCount: number
  bestSnippet: string
}

export interface SnippetHit {
  conversationId: string
  seq: number
  type: string
  subtype?: string
  snippet: string
  score: number
  createdAt: number
  conversation?: { title?: string; project?: string }
}

export interface SearchResponse {
  hits: Array<{
    id: number
    conversationId: string
    seq: number
    type: string
    subtype?: string
    snippet: string
    score: number
    createdAt: number
    conversation?: { id: string; project?: string; title?: string; description?: string }
  }>
  total: number
  query: string
}

export type ViewMode = 'conversations' | 'snippets'
export type SortMode = 'relevance' | 'recency'

export function parseConversationHits(data: SearchResponse): ConversationHit[] {
  const grouped = new Map<string, ConversationHit>()
  for (const hit of data.hits) {
    const existing = grouped.get(hit.conversationId)
    if (existing) {
      existing.hitCount++
    } else {
      grouped.set(hit.conversationId, {
        conversationId: hit.conversationId,
        title: hit.conversation?.title || 'untitled',
        project: hit.conversation?.project || '',
        hitCount: 1,
        bestSnippet: hit.snippet || '',
      })
    }
  }
  return [...grouped.values()]
}

export function parseSnippetHits(data: SearchResponse): SnippetHit[] {
  return data.hits.map(h => ({
    conversationId: h.conversationId,
    seq: h.seq,
    type: h.type,
    subtype: h.subtype,
    snippet: h.snippet || '',
    score: h.score,
    createdAt: h.createdAt,
    conversation: h.conversation,
  }))
}
