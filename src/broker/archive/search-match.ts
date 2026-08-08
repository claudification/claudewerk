/** Matching + snippet extraction for cold-archive search.
 *
 *  The prefilter runs against the RAW ndjson line, before any JSON parsing --
 *  that is what makes a grep over 25 GB of decompressed text finish at all. A
 *  literal needle is therefore escaped the way JSON escaped it on the way in
 *  (`he said "no"` -> `he said \"no\"`), or a search for anything containing a
 *  quote, a backslash or a newline would silently find nothing.
 *
 *  A regex has no such translation and is documented as running against the
 *  escaped line. That is a real sharp edge, not a bug to paper over: `\n` in the
 *  archive is two characters.
 */

export interface Matcher {
  /** Cheap test against the raw line. */
  test(line: string): boolean
  /** Index of the match inside decoded text, or -1. Used only for snippets. */
  find(text: string): { index: number; length: number } | null
}

function escapeForJson(needle: string): string {
  const quoted = JSON.stringify(needle)
  return quoted.slice(1, quoted.length - 1)
}

export function buildMatcher(query: string, opts: { regex?: boolean; caseSensitive?: boolean } = {}): Matcher {
  if (opts.regex) {
    const re = new RegExp(query, opts.caseSensitive ? '' : 'i')
    return {
      test: line => re.test(line),
      find: text => {
        const m = re.exec(text)
        return m ? { index: m.index, length: m[0].length } : null
      },
    }
  }

  const escaped = escapeForJson(query)
  const rawNeedle = opts.caseSensitive ? escaped : escaped.toLowerCase()
  const plainNeedle = opts.caseSensitive ? query : query.toLowerCase()
  return {
    test: line => (opts.caseSensitive ? line : line.toLowerCase()).includes(rawNeedle),
    find: text => {
      const index = (opts.caseSensitive ? text : text.toLowerCase()).indexOf(plainNeedle)
      return index === -1 ? null : { index, length: query.length }
    },
  }
}

/** A window of `content` around the match, with the ends marked so a caller can
 *  see the text was cut rather than guessing. */
export function snippetAround(content: string, matcher: Matcher, contextChars: number): string {
  const hit = matcher.find(content)
  // No hit inside `content` means the line matched on another column (a uuid, a
  // conversation id); show the head rather than nothing.
  const centre = hit ? hit.index + Math.floor(hit.length / 2) : Math.floor(Math.min(content.length, contextChars) / 2)
  const start = Math.max(0, centre - contextChars)
  const end = Math.min(content.length, centre + contextChars)
  const body = content.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '...' : ''}${body}${end < content.length ? '...' : ''}`
}
