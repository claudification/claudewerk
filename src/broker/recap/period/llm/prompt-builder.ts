import { extractProjectLabel } from '../../../../shared/project-uri'
import type { RecapAudience } from '../../../../shared/protocol'
import {
  AGENT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_ID,
  loadTemplates,
  type RecapTemplate,
  renderTemplateBody,
  resolveOptionFlags,
} from '../../templates'
import type { ContentionDigest } from '../gather/contention-types'
import type {
  CommitDigest,
  ConversationDigest,
  CostDigest,
  ErrorDigest,
  ForgottenThreadDigest,
  OpenQuestionDigest,
  TaskDigest,
  ToolUseDigest,
  TranscriptDigest,
} from '../gather/types'
import { renderContentionSection } from './render-contention'
import { renderForgottenSection } from './render-forgotten'
import { renderStatusSection } from './render-status'
import { renderTranscriptsSection, shortId } from './render-transcripts'

export interface PromptInputs {
  projectLabel: string
  periodHuman: string
  periodIsoRange: string
  conversations: ConversationDigest[]
  transcripts: TranscriptDigest[]
  cost: CostDigest
  tasks: TaskDigest
  tools: ToolUseDigest
  errors: ErrorDigest
  openQuestions: OpenQuestionDigest
  forgotten: ForgottenThreadDigest
  commits: CommitDigest
  /** Multi-agent contention evidence -- present only when the `contention` signal
   *  is on (the agentic-retrospect template). Rendered as an authoritative input block
   *  the LLM grounds its recommendations in; absent on every other recap. */
  contention?: ContentionDigest
}

export interface BuiltPrompt {
  system: string
  user: string
  inputChars: number
}

/**
 * The resolved presentation a recap run renders with: the selected template +
 * the already-resolved option flags. Threaded from the orchestrator (which
 * resolves both ONCE, so the same selection drives the prompt, the signal set,
 * the cache key, and args_json). Omitted entirely -> the memoized anchor default
 * (preserves every existing caller + the byte-identical anchor path).
 */
export interface PresentationSelection {
  template?: RecapTemplate
  optionFlags?: Record<string, boolean>
}

export function buildPrompt(
  inputs: PromptInputs,
  audience: RecapAudience = 'human',
  retrospect = false,
  customerFriendly = false,
  presentation?: PresentationSelection,
  instructions?: string,
): BuiltPrompt {
  const base = renderBody({
    path: 'oneshot',
    audience,
    scopeLabel: inputs.projectLabel,
    periodHuman: inputs.periodHuman,
    periodIsoRange: inputs.periodIsoRange,
    stats: humanStats(inputs),
    ...presentation,
  })
  const system = applyRetroCf(base, retrospect, customerFriendly, instructions)
  const user = userPayload(inputs)
  return { system, user, inputChars: system.length + user.length }
}

/**
 * Append the retrospect + customer-friendly layers on top of an audience body.
 * SHARED by the oneshot ({@link buildPrompt}) and synthesize
 * (`buildSynthesizePrompt`) paths so the two cannot drift in ordering:
 *   - Pillar F: retrospect is ADDITIVE -- the evaluative frontmatter + body
 *     section append on top of whichever audience body was chosen.
 *   - Customer-friendly tone appends LAST so it OVERRIDES the body spec's
 *     "Frustrations ... do not sanitise" instruction with the opposite directive.
 *   - Free-text user `instructions` append AFTER even that, so they are the final
 *     word and can override any earlier spec (including customer-friendly). Empty /
 *     whitespace-only is a no-op. Presentation-only -- this shapes the PROSE the
 *     refinement stage writes, never what the map stage already extracted + stored.
 */
export function applyRetroCf(
  base: string,
  retrospect: boolean,
  customerFriendly: boolean,
  instructions?: string,
): string {
  const withRetro = retrospect ? `${base}\n\n${RETRO_FRONTMATTER_SPEC}\n\n${RETRO_BODY_SPEC}` : base
  const withCf = customerFriendly ? `${withRetro}\n\n${CUSTOMER_FRIENDLY_SPEC}` : withRetro
  const trimmed = instructions?.trim()
  return trimmed ? `${withCf}\n\n${customInstructionsSpec(trimmed)}` : withCf
}

/**
 * The final user-directive layer. Wraps the caller's free-text so the model treats
 * it as an authoritative override of the body spec (matching how CUSTOMER_FRIENDLY
 * frames its overrides). The directives shape the WRITTEN recap only; they never
 * change the facts, citations, or `inferred` flags carried up from extraction, and
 * a "don't mention X" directive omits X from the rendered body -- it does not remove
 * X from the stored frontmatter/bundle.
 */
function customInstructionsSpec(instructions: string): string {
  return `ADDITIONAL USER DIRECTIVES (apply on top of everything above; these are the FINAL word and OVERRIDE the body spec wherever they conflict):
${instructions}

These shape the WRITTEN recap only. Never invent facts, drop citations, or upgrade an inference to a fact to satisfy a directive; if a directive says to omit something, simply leave it out of the prose.`
}

function humanStats(inputs: PromptInputs): RenderStats {
  return {
    conversations: inputs.conversations.length,
    commits: inputs.commits.perProject.reduce((sum, p) => sum + p.commits.length, 0),
    projects: inputs.commits.perProject.map(p => extractProjectLabel(p.projectUri)),
  }
}

// The default (anchor) templates, loaded once per audience. The templates dir is
// tiny and read-mostly; per PLAN section 5 there is no hot-reload machinery. The
// default tracks the resolved audience -- human -> project-recap, agent ->
// agent-handoff -- so a default agent recap renders the agent brief, not the human
// recap with the agent body spec. `undefined` means the audience's template is
// missing/broken; the path then falls back to the in-code spec for that audience
// (below), so a recap never breaks on a template error. We read the map by id
// DIRECTLY (not via pickTemplate) so a missing agent-handoff degrades to the
// agent in-code fallback rather than silently rendering the human anchor.
const defaultTemplateCache = new Map<RecapAudience, RecapTemplate | undefined>()
function getDefaultTemplate(audience: RecapAudience): RecapTemplate | undefined {
  if (!defaultTemplateCache.has(audience)) {
    const id = audience === 'agent' ? AGENT_TEMPLATE_ID : DEFAULT_TEMPLATE_ID
    defaultTemplateCache.set(audience, loadTemplates().templates.get(id))
  }
  return defaultTemplateCache.get(audience)
}

/** Render path: which wrapper is asking for the body. The CONTRACT
 *  (frontmatter + body sections) is path-independent; only the framing differs. */
export type RecapRenderPath = 'oneshot' | 'synthesize'

/** Data counts a template body may surface; unused by the anchor but part of the
 *  shared render-context shape so a future template gets them on BOTH paths. */
export interface RenderStats {
  conversations: number
  commits: number
  projects: string[]
}

/** Inputs to the SHARED recap-body renderer -- the one seam both the oneshot and
 *  synthesize wrappers feed from (PLAN section 3), for BOTH audiences. The
 *  synthesize path has no conversation list, so `stats` is optional. */
export interface BodyArgs {
  path: RecapRenderPath
  /** Which deliverable shape to render. Selects the audience-appropriate default
   *  template (human -> project-recap, agent -> agent-handoff), the body spec
   *  injected into the Liquid context (HUMAN_BODY_SPEC vs AGENT_BODY_SPEC), and
   *  the in-code fallback framing + body spec. */
  audience: RecapAudience
  scopeLabel: string
  periodHuman: string
  periodIsoRange: string
  /** The selected presentation template. Defaults to the memoized anchor for the
   *  audience (`project-recap` / `agent-handoff`) when omitted -- this is what
   *  keeps the existing callers and the byte-identical anchor paths unchanged. */
  template?: RecapTemplate
  /** Already-resolved option flags (id -> boolean) for the Liquid `options.<id>`
   *  context. The orchestrator resolves these once (so the same flags drive the
   *  signal set, the cache key, and args_json) and passes them straight through.
   *  When omitted, they are resolved from `options` against the chosen template. */
  optionFlags?: Record<string, boolean>
  /** Raw user option overrides; used to resolve flags only when `optionFlags`
   *  is not supplied (resolved against the chosen template's declared options). */
  options?: Record<string, boolean>
  stats?: RenderStats
}

/** The body contract spec for an audience (the markdown-body section the template
 *  injects ONCE as `{{ body_spec }}`). Frontmatter is audience-independent. */
function bodySpecFor(audience: RecapAudience): string {
  return audience === 'agent' ? AGENT_BODY_SPEC : HUMAN_BODY_SPEC
}

/** The synthesize-framing reader clause for an audience. */
function synthesizeReaderFor(audience: RecapAudience): string {
  return audience === 'agent' ? AGENT_SYNTHESIZE_READER : HUMAN_SYNTHESIZE_READER
}

/**
 * The Liquid render context shared by every template body (PLAN section 4):
 * resolved `options`, `audience`, render `path`, `scope_label`, `period`, and
 * data `stats`. The two large FIXED specs are supplied here too so a template
 * body injects them ONCE as `{{ frontmatter_spec }}` / `{{ body_spec }}` -- which
 * is what makes the CONTRACT identical across the oneshot and synthesize paths
 * (only the path-branched framing differs). `body_spec` is keyed by audience
 * (HUMAN_BODY_SPEC vs AGENT_BODY_SPEC), so the agent-handoff template injects the
 * agent body and the project-recap template the human body. Single-sourced.
 */
function renderContext(args: BodyArgs, optionFlags: Record<string, boolean>): Record<string, unknown> {
  return {
    options: optionFlags,
    audience: args.audience,
    path: args.path,
    scope_label: args.scopeLabel,
    period: { human: args.periodHuman, iso_range: args.periodIsoRange },
    frontmatter_spec: FRONTMATTER_SPEC,
    body_spec: bodySpecFor(args.audience),
    stats: args.stats ?? { conversations: 0, commits: 0, projects: [] },
  }
}

/**
 * Render the recap presentation body for the given path + audience. This is the
 * ONE seam both the oneshot wrapper ({@link buildPrompt}) and the synthesize
 * wrapper (`buildSynthesizePrompt`) feed from, for BOTH audiences: the default
 * template (project-recap / agent-handoff) branches its framing on `path` but
 * injects the frontmatter + body contract exactly once, so the two paths cannot
 * drift (guarded by the anchor + agent byte-identity tests + the path-parity
 * test). Falls back to the in-code spec if the template is absent or fails to
 * render -- a recap must never break on a template error.
 */
export function renderBody(args: BodyArgs): string {
  const template = args.template ?? getDefaultTemplate(args.audience)
  if (template) {
    try {
      return renderTemplateBody(template, renderContext(args, resolveBodyFlags(template, args)))
    } catch (err) {
      console.warn(
        `[recap-templates] render failed for "${template.id}" (${args.path}/${args.audience}), using in-code fallback: ${describeError(err)}`,
      )
    }
  }
  return bodyFallback(args)
}

/** Resolve the `options.<id>` Liquid booleans for a body render: the orchestrator's
 *  already-resolved flags when supplied, otherwise resolved from the raw user
 *  overrides against the chosen template's declared options. */
function resolveBodyFlags(template: RecapTemplate, args: BodyArgs): Record<string, boolean> {
  return args.optionFlags ?? resolveOptionFlags(template, args.options ?? {})
}

/** In-code body for when the template is missing/broken. Mirrors the template's
 *  two framing branches (per audience) so a recap still renders correctly without
 *  the .yml. */
function bodyFallback(args: BodyArgs): string {
  const framing =
    args.path === 'synthesize'
      ? synthesizeFraming(args.scopeLabel, args.periodHuman, args.periodIsoRange, synthesizeReaderFor(args.audience))
      : oneshotFraming(args.audience, args.scopeLabel, args.periodHuman, args.periodIsoRange)
  return `${framing}\n\n${FRONTMATTER_SPEC}\n\n${bodySpecFor(args.audience)}`
}

/** Oneshot framing for the in-code fallback, per audience. */
function oneshotFraming(
  audience: RecapAudience,
  scopeLabel: string,
  periodHuman: string,
  periodIsoRange: string,
): string {
  return audience === 'agent'
    ? agentOneshotFraming(scopeLabel, periodHuman, periodIsoRange)
    : humanOneshotFraming(scopeLabel, periodHuman, periodIsoRange)
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Pillar F -- retrospect frontmatter + body. APPENDED to either audience's prompt
 * when retrospect:true via the shared {@link applyRetroCf} helper (so the oneshot
 * and synthesize paths layer it identically). Emitted ONLY by Opus
 * (oneshot/synthesize), NEVER the cheap map stage. The three lists are JUDGMENT
 * (evaluation), so they may be inferred -- unlike the extraction sections, an
 * inferred retrospect item is expected.
 */
const RETRO_FRONTMATTER_SPEC = `ADDITIONAL RETROSPECT FRONTMATTER (this recap is also a RETROSPECTIVE -- EVALUATE the period, don't just report it):

  went_well: [<things that went WELL this period, as {title, detail?, conversations?, commits?}>]
  went_badly: [<things that went BADLY -- friction, relitigated decisions, recurring dead-ends, wasted effort -- as {title, detail?, conversations?}>]
  recommendations: [<concrete, ACTIONABLE improvements for the NEXT period, PRIORITISING rules / tools / CLAUDE.md / process changes, as {title, detail (what to change and why), conversations?}>]

These three are your JUDGMENT, grounded in the period's evidence. They MAY be inferred (set inferred: true). Cite conversations/commits where you can. OMIT a list if there is genuinely nothing for it; never pad.`

const RETRO_BODY_SPEC = `ADDITIONAL RETROSPECT BODY SECTION (append AFTER the sections above):

  ## Retrospective
  ### What went well
  The period's wins worth keeping.
  ### What went badly
  Friction, relitigation, recurring dead-ends, wasted effort -- be honest and specific.
  ### Recommendations
  Concrete changes for next period, most impactful first. Prioritise rules / tools /
  CLAUDE.md / process -- each one actionable enough to apply directly.`

/**
 * Customer-friendly tone directive. APPENDED LAST (after the body + any retrospect
 * spec) via the shared {@link applyRetroCf} helper when customerFriendly:true, so
 * it overrides the body spec's "do not sanitise the frustrations" line. Opus-only
 * (oneshot + chunked reduce) -- the cheap map stage still extracts raw facts;
 * sanitising the VOICE is a judgment the reduce/oneshot pass makes. Never alters
 * the facts, citations, or inferred flags.
 */
const CUSTOMER_FRIENDLY_SPEC = `CUSTOMER-FRIENDLY TONE (this recap will be shared OUTSIDE the team -- sanitise the VOICE, never the facts):
  - OMIT the \`frustrations\` frontmatter list AND the "## Frustrations" body section ENTIRELY. This OVERRIDES the earlier instruction to include them -- a customer-facing recap carries no venting.
  - REFRAME went_badly / dead_ends / "## What went badly" / "## Dead ends" as neutral, blameless, constructive notes: state what changed or was learned, not who suffered ("the auth flow was reworked after the first approach proved brittle", NOT "wasted a day fighting broken auth").
  - STRIP profanity, sarcasm, exasperation, and blame toward tools, vendors, or people. Use a calm, professional, external-facing voice throughout.
  - PRESERVE every fact, citation (conversation ids, commit hashes), and \`inferred\` flag exactly. Only the TONE changes -- never drop technical content to soften it.`

/**
 * YAML frontmatter contract -- IDENTICAL for both audiences. The frontmatter
 * is the search index (parse-recap.ts, recaps_fts); audience swaps only the
 * markdown body shape, never the frontmatter. EXPORTED: the chunked reduce
 * stage (chunk/synthesize-prompt.ts) reuses this exact contract so its output
 * round-trips parseRecapOutput like the oneshot path.
 */
export const FRONTMATTER_SPEC = `REQUIRED YAML FRONTMATTER (extract from the input, do not invent):

  subtitle: <single-line theme, 4-12 words>
  keywords: [<5-12 technical terms: feature names, file names, components, libraries, model names, table names>]
  hashtags: [<3-8 broader themes prefixed with #, e.g. "#sqlite-migration", "#ship-week", "#bug-cleanup", "#refactor", "#incident">]
  goals: [<1-5 things being attempted this period>]
  discoveries: [<0-10 notable findings, bugs identified, learnings, architectural insights, surprises>]
  side_effects: [<0-5 unintended consequences, scope creep, broken stuff, technical debt incurred>]
  features: [<each shipped feature as {title, detail?, conversations?, commits?}>]
  bugs:     [<each bug fixed as {title, detail?, conversations?, commits?}>]
  fixes:    [<refactors/cleanups as {title, detail?, conversations?, commits?}>]
  incidents: [<production/dev incidents as {title, conversations?, severity}>]
  decisions: [<non-obvious decisions made + WHY, as {title, detail (the reasoning a diff cannot show), conversations?}>]
  dead_ends: [<approaches tried then ABANDONED, as {title, detail (why it failed), conversations?, commits?}>]
  gotchas:  [<constraints/landmines discovered (tool/env quirks, surprising failures), as {title, detail?, conversations?}>]
  frustrations: [<0-8 moments the USER voiced frustration/friction this period -- repeated failures, "still broken", going in circles, wasted time, a tool fighting back -- as {title (their words where possible), detail (the trigger), conversations?}. OBSERVED from what the user said, never inferred; never invented>]
  open_questions: [<unresolved questions the assistant left for the user; PRIORITISE the OPEN_QUESTIONS section in the input>]
  stakeholders: [<0-5 people involved or mentioned by name>]

OMIT fields where there's nothing to put. NEVER invent items to fill quotas.
CITE: every features/bugs/fixes/incidents/decisions/dead_ends item names its
conversation ids (8-char) and commit hashes (7-char) where the input shows them.
FACT vs INFERENCE: a claim backed by a commit or task is a FACT -- state it
plainly. A claim concluded from transcript text only is an INFERENCE -- set
\`inferred: true\` on the item (or prefix the title with [inferred]). Never
present inference as fact.`

/**
 * Human recap body contract. EXPORTED so the chunked reduce stage emits the
 * identical body structure for human-audience recaps.
 */
export const HUMAN_BODY_SPEC = `MARKDOWN BODY (after the closing --- of frontmatter):

  ## TL;DR
  3-5 bullets, the most important things from the period

  ## Features shipped
  Bulleted, link conversations via [text](/sessions/conv_xxx...), cite commits

  ## Bug fixes
  Bulleted, with commit hashes (short form)

  ## Refactors / cleanup

  ## Decisions
  Non-obvious decisions made this period and WHY -- the reasoning a diff cannot
  show. Cite the conversation where it was decided. Omit the section if none.

  ## Dead ends
  Approaches tried this period and ABANDONED, each with the reason it failed.
  git keeps no record of abandoned work -- this is high-value. Omit if none.

  ## Gotchas
  Constraints or landmines discovered: a tool that misbehaves, an environment
  quirk, a surprising failure mode. Omit the section if none.

  ## Frustrations
  Where the user hit friction and said so: things that broke repeatedly, time
  sunk fighting tooling, decisions relitigated, "why is this still happening".
  Quote or closely paraphrase the user and cite the conversation. This is the
  pain signal that feeds process fixes -- be honest, do not sanitise. Omit if none.

  ## Incidents / errors
  (omit section if none)

  ## Open questions / unresolved
  CRITICAL SECTION. List every conversation in the input's OPEN_QUESTIONS
  block with the unanswered question(s) the assistant left for the user.
  Group by conversation. Surface anything that was waiting on a user
  decision and never got one. Do not invent open questions; only use
  ones present in the input.

  ## Loose ends -- forgotten threads
  Invested conversations from BEFORE this period that were abandoned mid-work,
  each left on a question you never answered -- work you may have forgotten you
  started. Render EVERY thread in the FORGOTTEN_THREADS input as a bullet:
  link it via [short label](/sessions/conv_xxx...), state how long it's been
  idle and its turn count, and write a one-line synthesis of what it was about
  (use the title if present, else infer a label from LAST USER / LEFT AT). Lead
  with the open question that was left hanging. Most-invested first. This is the
  "you forgot this existed" section -- omit only if FORGOTTEN_THREADS is empty.

  ## Tasks completed
  Project board items closed in the period

  ## Notable conversations
  Top 3-5 by length/intensity, with links

DO NOT regenerate the cost/token table -- it's inserted programmatically.
DO NOT include greetings, sign-offs, or the H1 title (templated).
Be concrete. Use the project's actual terms verbatim.`

/**
 * Agent orientation-brief body contract. Injected into the Liquid render context
 * as `{{ body_spec }}` for agent-audience recaps (so the agent-handoff template
 * single-sources it), and used by the in-code agent fallback. Internal to this
 * module since the agent path now renders through the shared {@link renderBody} seam.
 */
const AGENT_BODY_SPEC = `MARKDOWN BODY (after the closing --- of frontmatter):

  ## TL;DR
  One or two lines. The single most important thing a fresh agent must know
  before it touches this project.

  ## State
  What is TRUE RIGHT NOW. Prioritise: work in flight that is NOT yet
  committed (a fresh agent may collide with another agent mid-edit),
  half-finished refactors, which branch is hot, what just shipped that the
  reader should build ON rather than redo. Facts from commits and closed
  tasks stated plainly; transcript-derived state tagged [inferred].

  ## Decisions
  Non-obvious decisions made this period and WHY -- the reasoning a diff
  cannot show. This is what stops the reader relitigating or contradicting
  a settled choice. Cite the conversation where it was decided.

  ## Dead ends -- do NOT retry
  Approaches that were tried and ABANDONED, each with the reason it failed.
  git keeps no record of abandoned work -- this section is the brief's
  highest-value content and exists nowhere else. Omit the section only if
  the input genuinely shows no abandoned approach.

  ## Open questions
  Unresolved questions the assistant left for the user that never got an
  answer. Use the OPEN_QUESTIONS input block VERBATIM -- do not invent.
  Group by conversation.

  ## Gotchas
  Constraints or landmines discovered this period: a tool that misbehaves,
  an environment quirk, a non-obvious dependency, a surprising failure
  mode. Only include something that would actually bite the reader.

  ## Forgotten -- may want to resume
  Invested conversations from BEFORE this period, abandoned mid-work and left on
  a question the user never answered. Render EVERY thread in the
  FORGOTTEN_THREADS input: link it (/sessions/conv_xxx...), give idle-age + turn
  count, a one-line synthesis of what it was about (title if present, else infer
  from LAST USER / LEFT AT), and the open question it stalled on. These are
  candidate work to RESUME -- the user may not remember they exist. Omit the
  section only if FORGOTTEN_THREADS is empty.

  ## Pick up here
  The obvious next actions, most important first. If there is genuinely
  nothing pending, say so in a single line.

DO NOT include greetings, sign-offs, an H1 title, or a cost table.
DO NOT pad. Use the project's actual terms verbatim.`

/**
 * Oneshot framing for the human recap (header + ground rules) -- the text the
 * default template's `path != 'synthesize'` branch reproduces. Kept here as the
 * canonical source for the in-code fallback; the anchor byte-identity test pins
 * the template render to it.
 */
function humanOneshotFraming(scopeLabel: string, periodHuman: string, periodIsoRange: string): string {
  return `You are writing a comprehensive development recap for project ${scopeLabel}
covering ${periodHuman} (${periodIsoRange}).

Output format: a YAML frontmatter block (between --- lines) followed by markdown body.
The frontmatter is parsed and indexed -- be specific so future searches find this recap.

GROUND RULES:
  - GROUND EVERY CLAIM. The input includes real COMMITS (with files-changed and
    +/- line counts) and TASKS. Tie features/bugs/fixes to specific commit
    hashes (7-char) and conversation ids (8-char), and name real files + project
    terms verbatim -- "rebuilt admin/files.tsx (a1b2c3d)", NOT "admin work".
  - FACT vs INFERENCE. A claim backed by a commit/task is a FACT. A claim read
    from transcript text only is an INFERENCE -- mark it inferred (frontmatter
    \`inferred: true\`, or [inferred] in prose). Never dress inference as fact.
  - Vague, abstracted summaries are a failure. Be concrete and specific.`
}

/** The human reader description in the synthesize framing. EXPORTED for the
 *  path-parity test (the human synthesize framing is pinned against it). */
export const HUMAN_SYNTHESIZE_READER = 'a human reading a development recap'
/** The agent reader description in the synthesize framing. Internal -- the agent
 *  synthesize framing is single-sourced via the agent-handoff template + the
 *  in-code fallback, both inside this module. */
const AGENT_SYNTHESIZE_READER =
  'a fresh Claude Code agent session with zero prior context, about to do real work in this project'

/**
 * CHUNKED:Final framing -- the synthesize/reduce header + ground rules, shared by
 * the human path (default template's `path == 'synthesize'` branch + the in-code
 * fallback) and the agent path (`buildSynthesizePrompt`). Only the `reader` clause
 * differs between audiences. The DELIVERABLE contract (frontmatter + body spec) is
 * appended by the caller from the SAME single source the oneshot path uses.
 */
export function synthesizeFraming(
  scopeLabel: string,
  periodHuman: string,
  periodIsoRange: string,
  reader: string,
): string {
  return `You are SYNTHESIZING the final recap for project ${scopeLabel},
covering ${periodHuman} (${periodIsoRange}). The reader is ${reader}.

The facts below were already EXTRACTED from the period's transcripts in parallel
(map stage) and MERGED + de-duplicated IN CODE. Your job is JUDGMENT and PROSE,
NOT extraction:
  - REFINE the merged items: collapse near-duplicates the code merge missed
    (same thing, different wording), keep the most specific title, merge details.
  - PRESERVE every citation (conversation ids, commit hashes) and every
    "inferred" flag exactly as given -- never upgrade an inference to a fact.
  - DO NOT invent items, citations, or facts that are not in the merged input
    OR the FORGOTTEN_THREADS block below (the latter is authoritative,
    deterministic data -- render it, don't second-guess it).
    You have no transcripts here; everything else you state must trace to the input.
  - DROP anything genuinely empty; never pad to fill a section.

Output format: a YAML frontmatter block (between --- lines) followed by the
markdown body. The frontmatter is parsed and indexed -- carry the merged facts
into it faithfully.`
}

/**
 * Oneshot framing for the agent orientation brief (header + the bar + ground
 * rules) -- the text the default `agent-handoff` template's `path != 'synthesize'`
 * branch reproduces. Kept here as the canonical source for the in-code fallback;
 * the agent byte-identity test pins the template render to it. A terse brief for a
 * fresh Claude Code session with zero context: high signal, low noise -- every
 * line must change what the reader does next. Carries what git cannot: dead ends,
 * in-flight state, decisions + rationale. See plan-recap-audience.md section 4.
 */
function agentOneshotFraming(scopeLabel: string, periodHuman: string, periodIsoRange: string): string {
  return `You are writing an ORIENTATION BRIEF for project ${scopeLabel},
covering ${periodHuman} (${periodIsoRange}).

THE READER IS NOT A HUMAN. It is a fresh Claude Code agent session with zero
prior context, about to do real work in this project. It reads this brief
once, then acts. Every line costs the reader context budget and may change
what it does next. Write for that reader and no other.

THE BAR -- apply to every single bullet:
  "Would a fresh agent do something DIFFERENT because of this line?"
  If no -- DELETE the line. A short brief that is all signal beats a
  complete one padded with noise. Target: body under ~400 words.

GROUND RULES:
  - FACT vs INFERENCE. A claim backed by a commit hash or a closed task is
    a FACT -- state it plainly. A claim concluded from transcript text is
    an INFERENCE -- prefix it literally with "[inferred]". NEVER present
    inference as fact. The reader will act on this; a confident wrong claim
    is the worst output you can produce.
  - CITE EVERYTHING. Every claim names its source: commit hash (7 char),
    conversation id (8 char), or task name. A claim with no citation and no
    [inferred] tag does not belong here -- drop it.
  - NO NARRATIVE. Do not tell the story of the period. State what is TRUE
    NOW and what to DO NEXT.
  - The reader already has 'git log'. Do NOT reproduce a commit changelog.
    Mention a commit ONLY when the WHY behind it is not visible in its diff.
  - OMIT empty sections entirely. Never write a section just to say "none".

Output format: a YAML frontmatter block (between --- lines) followed by the
markdown body. The frontmatter is parsed and indexed for search.`
}

function userPayload(inputs: PromptInputs): string {
  const parts: string[] = []
  parts.push(renderConversationsSection(inputs.conversations))
  // Highest-confidence signal, right after the conversation list. Empty (omitted
  // by the filter below) when the agent_status signal is off or nobody reported.
  parts.push(renderStatusSection(inputs.conversations))
  parts.push(renderTranscriptsSection(inputs.transcripts))
  parts.push(renderTasksSection(inputs.tasks))
  parts.push(renderToolsSection(inputs.tools))
  parts.push(renderErrorsSection(inputs.errors))
  parts.push(renderOpenQuestionsSection(inputs.openQuestions))
  parts.push(renderForgottenSection(inputs.forgotten))
  parts.push(renderContentionSection(inputs.contention))
  parts.push(renderCommitsSection(inputs.commits))
  parts.push(renderCostSummary(inputs.cost))
  parts.push('\nWrite the recap now.')
  return parts.filter(Boolean).join('\n\n')
}

function renderConversationsSection(convs: ConversationDigest[]): string {
  if (convs.length === 0) return 'CONVERSATIONS: (none in period)'
  const lines = convs.map(c => `- ${shortId(c.id)} "${c.title}" (${c.turnCount} turns, ${c.status})`)
  return `CONVERSATIONS (${convs.length}):\n${lines.join('\n')}`
}

function renderTasksSection(tasks: TaskDigest): string {
  const parts: string[] = ['TASKS:']
  if (tasks.doneInPeriod.length) {
    parts.push(`  done (${tasks.doneInPeriod.length}):`)
    for (const t of tasks.doneInPeriod) parts.push(`    - [${shortId(t.conversationId)}] ${t.name}`)
  }
  if (tasks.createdInPeriod.length) {
    parts.push(`  created (${tasks.createdInPeriod.length}):`)
    for (const t of tasks.createdInPeriod) parts.push(`    - [${shortId(t.conversationId)}] ${t.name} (${t.status})`)
  }
  if (tasks.inProgress.length) {
    parts.push(`  in progress (${tasks.inProgress.length}):`)
    for (const t of tasks.inProgress) parts.push(`    - [${shortId(t.conversationId)}] ${t.name}`)
  }
  if (parts.length === 1) parts.push('  (none)')
  return parts.join('\n')
}

function renderToolsSection(tools: ToolUseDigest): string {
  if (tools.perConversation.length === 0) return 'TOOL USE: (none)'
  const lines = tools.perConversation.slice(0, 10).map(p => {
    const top = p.perTool
      .slice(0, 5)
      .map(t => `${t.tool}=${t.count}`)
      .join(', ')
    return `  ${shortId(p.conversationId)}: total=${p.total} (${top})`
  })
  return `TOOL USE (top 10 conversations):\n${lines.join('\n')}`
}

function renderErrorsSection(errors: ErrorDigest): string {
  if (errors.incidents.length === 0) return 'INCIDENTS: (none)'
  const lines = errors.incidents.map(e => `  - ${shortId(e.conversationId)} [${e.subtype}] ${e.summary}`)
  return `INCIDENTS:\n${lines.join('\n')}`
}

function renderOpenQuestionsSection(open: OpenQuestionDigest): string {
  if (open.conversationsWithOpenQuestions.length === 0) return 'OPEN_QUESTIONS: (none)'
  const blocks = open.conversationsWithOpenQuestions.map(o => {
    const qs = o.openQuestions.map(q => `    Q: ${q}`).join('\n')
    return `  ${shortId(o.conversationId)} "${o.conversationTitle}"\n    LAST USER: ${o.lastUserPrompt}\n${qs}`
  })
  return `OPEN_QUESTIONS (conversations ending on questions the user never answered):\n${blocks.join('\n\n')}`
}

function renderCommitsSection(commits: CommitDigest): string {
  const totalCommits = commits.perProject.reduce((sum, p) => sum + p.commits.length, 0)
  if (totalCommits === 0) return 'COMMITS: (no git data available for this recap)'
  const blocks = commits.perProject.map(p => {
    const lines = p.commits.map(c => `  ${c.sha.slice(0, 7)} ${c.subject}${commitStat(c)}`).join('\n')
    return `  ${extractProjectLabel(p.projectUri)}:\n${lines}`
  })
  return `COMMITS (${totalCommits}) -- format: <sha> <subject> [<files>f +<ins>/-<del>]:\n${blocks.join('\n\n')}`
}

function commitStat(c: CommitDigest['perProject'][number]['commits'][number]): string {
  if (c.filesChanged === undefined) return ''
  return ` [${c.filesChanged}f +${c.insertions ?? 0}/-${c.deletions ?? 0}]`
}

function renderCostSummary(cost: CostDigest): string {
  return `COST SUMMARY (rendered programmatically into the final document; for context only): total=$${cost.totalCostUsd.toFixed(4)} turns=${cost.totalTurns} input=${cost.totalInputTokens} output=${cost.totalOutputTokens}`
}
