/**
 * The `@project` token, edited IN THE RAW STRING rather than in the parsed
 * query.
 *
 * Clicking a project dot has to be visible in the header box -- the user must
 * see `@remote-claude` appear, be able to edit it by hand, and clear it by
 * clicking the same dot again. That only works if the click writes the same
 * text a human would have typed. Setting a field on the parsed query instead
 * would leave the box and the filter disagreeing the moment either one changed.
 *
 * This is a raw-string editor, not a second parser: it finds the unquoted `@x`
 * tokens and nothing else. Quoted spans (`"@literal"`) and exclusions (`-@x`)
 * are left exactly where they were, because the grammar reads both as something
 * other than a project scope.
 */

/** Quoted spans first, so a quoted `"@x"` is one token and never a scope. */
const RAW_TOKEN = /"[^"]*"|'[^']*'|\S+/g

/**
 * Whitespace-free scope token for a project name.
 *
 * The grammar splits on whitespace and matches `@x` by SUBSTRING, so a
 * multi-word project name has no exact token. The first word is the honest
 * approximation: broader than the full name, never narrower, so a chip click
 * can over-match but can never hide the rows it was meant to reveal.
 */
export function projectToken(project: string): string {
  return project.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

export interface StrippedProject {
  /** Every token except the `@x` scopes, in their original order and spelling. */
  kept: string[]
  /** The last `@x` scope that was in the string, lowercased, or null. */
  had: string | null
}

/** Pull every unquoted `@x` scope out of a raw query string. */
export function stripProjectTokens(raw: string): StrippedProject {
  const kept: string[] = []
  let had: string | null = null
  for (const token of raw.match(RAW_TOKEN) ?? []) {
    // A bare `@` is free text (the parser needs a payload), so it stays.
    if (!token.startsWith('@') || token.length === 1) {
      kept.push(token)
      continue
    }
    had = token.slice(1).toLowerCase()
  }
  return { kept, had }
}

/** Replace the `@x` scope in `raw`, or drop it entirely when `project` is null. */
export function withProject(raw: string, project: string | null): string {
  const { kept } = stripProjectTokens(raw)
  const token = project === null ? '' : projectToken(project)
  if (token) kept.push(`@${token}`)
  return kept.join(' ')
}

/** Set the `@x` scope, or clear it when the same project is already scoped. */
export function toggledProject(raw: string, project: string): string {
  const { kept, had } = stripProjectTokens(raw)
  const token = projectToken(project)
  if (token && token !== had) kept.push(`@${token}`)
  return kept.join(' ')
}
