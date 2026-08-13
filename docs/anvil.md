# ANVIL

```
      ╭──────────────────────────────────────────────────────────────╮
      │   ┌───────┐                                                  │
      │   │ ◉   ◉ │    A N V I L                                     │
      │   │   ⌄   │    Agent-Native Visual Interaction Language      │
      │   └──┬─┬──┘    rich interfaces INSIDE the transcript.        │
      │      ╰─╯       every touch compiles down to structured text. │
      ╰──────────────────────────────────────────────────────────────╯
```

> **Status:** v1 spec, partially implemented. See §1 for exactly what is built.\
> **Code:** `web/src/components/anvil/`\
> **Board:** [anvil-epic](../.rclaude/project/cards/anvil-epic.md) plus 13 children.\
> **Scope:** a text DSL an agent emits mid-sentence, the renderer that turns it
> into real UI inline in the chat stream, and the structured-text tag every
> interaction compiles back into.

---

## 0. Sixty seconds

ANVIL has exactly two halves.

````
   ┌──────────────────────────┐                ┌──────────────────────────┐
   │  DOWN: a fenced block    │                │  UP: a structured tag    │
   │  the agent writes        │  ─── human ──► │  the client writes text. │
   │  markdown. The client    │      clicks    │  The agent reads text.   │
   │  renders it as REAL UI.  │                │                          │
   └──────────────────────────┘                └──────────────────────────┘
              ```anvil                                   <stamp …>
````

Down, mid-sentence, in an ordinary message:

````markdown
Nice. Which of these feels like you?

```anvil
@gallery id=mood select=many max=2
? Pick the ones that feel right
- ed | Editorial | dense, warm | img=https://cdn.gate/m/ed.jpg
- sw | Swiss     | airy, cold  | img=https://cdn.gate/m/sw.jpg
- br | Brutal    | loud, black | img=https://cdn.gate/m/br.jpg
```
````

That renders as a row of clickable image cards. The human picks two and
confirms. The cards **stamp** -- the picked ones lift, the rest fade, forever.

Up, into the agent's context, as a plain user turn:

```xml
<stamp block="mood" kind="gallery" values="ed,br" labels="Editorial,Brutal">
I picked Editorial and Brutal.
</stamp>
```

**That tag is the entire integration.** No tool calls, no widget runtime, no
event bus reaching into the agent loop. Emit markdown, read text.

The attributes are the truth. The sentence inside is the courtesy -- it exists
so the transcript still reads like a conversation six months from now.

---

## 1. Where we are

A render-only spike is **shipped and deployed**. Every control renders at full
fidelity and is `disabled`. Nothing stamps, locks, or reaches the broker.

| Piece | State |
|---|---|
| `parse.ts` `rows.ts` `types.ts` | **built.** Total by contract, fuzz-tested |
| `render.ts` `blocks.ts` `icons.ts` | **built.** Emits an HTML string |
| `@note` `@choice` `@gallery` `@input` `@scale` | **built**, inert |
| Inline SVG icons, `icon=` override | **built** |
| Streaming guard (inert until fence closes) | **built** |
| `@code` | **not built** -- [anvil-code-block](../.rclaude/project/cards/anvil-code-block.md) |
| `@upload` `@link` `@order` `@example` `@void` | **not built** -- one card each |
| `<stamp>` tag, the stamp store, the five laws | **not built** -- [anvil-stamp-wire](../.rclaude/project/cards/anvil-stamp-wire.md), [anvil-lock-store](../.rclaude/project/cards/anvil-lock-store.md) |
| Untrusted framing, permission gate | **not built** -- and these are gaps this spec originally left |
| `danger` `phrase` `expires` `optional` `min` `max` | **parsed, no visual** -- [anvil-unrendered-attrs](../.rclaude/project/cards/anvil-unrendered-attrs.md) |

**The seam that matters:** `parse.ts`, `rows.ts`, `types.ts` and `icons.ts` are
durable and survive untouched when stamping lands. `render.ts` and `blocks.ts`
emit strings and get replaced when blocks need real state. **Do not build state
into the parser.**

### Why this exists alongside `dialog`

One-shot `dialog` and ANVIL are semantically the same thing. Verified at
`src/agent-host-common/mcp-host/mcp-tools/dialog.ts:219`: one-shot dialog does
**not** block -- it returns immediately and the answer arrives later as a
channel message, exactly like a stamp.

The difference is cost and placement. A dialog costs an MCP round trip and a
JSON layout; an ANVIL block costs four lines of markdown typed mid-sentence, and
it renders where the question was asked. That is why it will take the traffic
whether or not anyone decides it should.

The **live/persistent** dialog is genuinely different -- patch grammar,
compare-and-swap `setState`, tabs, redraw-in-place. ANVIL's founding axiom
forbids all of that on purpose. That tool stays.

---

## 2. The axiom, and what falls out of it

> A chat transcript is an append-only record of things that happened.\
> A widget that can be re-answered turns that record into a lie.

Hence:

| ANVIL is | ANVIL is not |
|---|---|
| Rich UI rendered **inside** a message bubble | A modal, drawer, overlay or popover |
| Answered exactly once, then frozen in place | A form you can revise |
| Compiled to text on the way up | An event stream you subscribe to |
| A closed set of blocks | An extensible widget framework |
| Authored by an LLM mid-sentence, no escaping pain | JSON you have to serialise carefully |

If you want a back-button, a re-open, a live-updating value, or a block that
mutates after it is drawn: you want the live dialog, not this.

---

## 3. The vocabulary

```
   ASK  (produce a <stamp>, then freeze)
     @choice    one-of-N or many-of-N, text rows
     @gallery   the same, but visual: images, swatches, typefaces, cards
     @input     typed fields
     @upload    file drop. Real attachments, not links.
     @link      paste a URL, get a fetched preview card
     @scale     one or more sliders between two named poles
     @order     drag N items into a ranking

   SHOW (never produce a stamp, never freeze)
     @note      prose, hints, warnings. Body is markdown.
     @code      a verbatim literal, inside the block
     @example   a canned value that fills an ASK block

   CONTROL
     @void      retract an unanswered block the conversation moved past
```

Ten blocks and one directive. Almost everything you will be tempted to add
(`@confirm`, `@yesno`, `@palette`, `@rate`, `@multi`, `@markdown`) is one of
these with an attribute set.

**On `@markdown` specifically:** it does not exist, deliberately. It would be
`@note` with different escaping. `@note` renders markdown; that covers it.
`@code lang=markdown` is a third thing again -- *show* markdown source rather
than *render* it -- so the two are not aliased.

---

## 4. Grammar

Line-oriented. One level of nesting, never more. Leading whitespace is
insignificant.

### 4.1 Sigils

| Sigil | Means | Appears in |
|---|---|---|
| `@` | block header: `@kind key=value key="quoted value"` | starts every block |
| `?` | the prompt. Repeatable; lines join with a newline. | all |
| `:` | subtext / help, rendered smaller under the prompt | all |
| `-` | an option row | `@choice` `@gallery` `@order` |
| `_` | a field row | `@input` |
| `%` | a scale row | `@scale` |
| `=` | a prefill row: `field=value` | `@example` |
| `>` | prose line (markdown) | `@note` |
| `#` | comment. Parsed, never rendered, never sent. | anywhere |
| `~~~` | literal fence, opens and closes a verbatim body | `@code` `@example` |

A line starting with none of the above is treated as prose and appended to the
current prompt. **Deliberate:** an agent that forgets a sigil gets slightly-wrong
rendering, never a crash.

### 4.2 Shape

```ebnf
doc      = block+ ;
block    = header , line* ;
header   = "@" , kind , { ws , attr } , NL ;
attr     = key , [ "=" , ( bareword | quoted ) ] ;      (* bare attr = true *)
option   = "-" , [ "!" ] , value , { "|" , cell } , NL ;
cell     = label | hint | ( key , "=" , value ) ;       (* img= swatch= font= *)
field    = "_" , name , [ "*" ] , "|" , type , { "|" , cell } , NL ;
scale    = "%" , name , "|" , leftPole , "|" , rightPole , [ "|" , default ] , NL ;
literal  = "~~~" , NL , { any } , "~~~" , NL ;
```

Pipes are the only column separator; pad them for readability, the parser trims.
A literal pipe inside a label is `\|`. Trailing `key=value` cells are unordered.

### 4.3 Why `~~~` and not backticks

An ANVIL fence is itself delimited by ` ``` `. **You cannot nest a backtick
fence inside a backtick fence** without asking the agent to count backticks
correctly, which is exactly the sort of thing that breaks mid-stream. `~~~` is
the in-block literal delimiter for that reason, and it is why `@code` is a
necessary block rather than sugar: a code sample that belongs *inside* a block
has no other way in, and content outside the fence is not part of the block --
so once stamping lands, it is not part of the frozen receipt either.

---

## 5. The blocks

Every ASK block shares these attributes:

| Attribute | Default | Meaning | Built? |
|---|---|---|---|
| `id` | derived (§10.2) | stable identity, and the `block=` in the stamp | yes |
| `select` | `one` | `one` stamps on click. `many` gives checkboxes plus a submit. | yes |
| `submit` | `"Confirm"` | button label | yes |
| `icon` | per kind | override the block's icon | yes |
| `min` `max` | -- | with `select=many`, bounds enforced before submit arms | **no** |
| `expires` | none | `30s` `15m` `2h`. Server-enforced (§7.5). | **no** |
| `optional` | off | a Skip affordance that still emits a stamp | **no** |
| `danger` | off | red framing plus a deliberate second click | **no** |
| `phrase` | -- | with `danger`: type this exact string to arm the button | **no** |

### 5.1 `@choice`

```anvil
@choice id=project-kind
? What are we actually building?
: If it is more than one, pick the one that pays for the others.
- site    | Marketing site    | pages, no login
- product | Product UI        | accounts, state, real users
- !scrap  | Start from scratch| we bin the existing brand
```

Prefix a value with `!` to mark that single row destructive.

```
   ╭─ ? What are we actually building? ─────────────────────────╮
   │  If it is more than one, pick the one that pays for the    │
   │  others.                                                   │
   │                                                            │
   │    [1]  Marketing site      pages, no login                │
   │    [2]  Product UI          accounts, state, real users    │
   │    [3]  Start from scratch  we bin the existing brand      │
   │                                                            │
   ╰──────────────────────────────────────────── preview ───────╯
```

Stamped, at **exactly the same height** (§11.2):

```
   ╭─ ? What are we actually building? ─────────────────────────╮
   │  If it is more than one, pick the one that pays for the    │
   │  others.                                                   │
   │                                                            │
   │         Marketing site      pages, no login                │
   │    ✓    Product UI          accounts, state, real users    │
   │         Start from scratch  we bin the existing brand      │
   │                                                            │
   ╰──────────────────────── stamped · Jonas · 14:02:11 ────────╯
```

Never collapse a stamped choice to one line. The rejected rows are part of the
record: they show what the human was choosing *between*.

### 5.2 `@gallery`

Same semantics as `@choice`, different renderer. `render=` picks the card body:

| `render` | Cell attribute | Card shows |
|---|---|---|
| `image` (default) | `img=<url>` | the image, 4:3, object-fit cover |
| `swatch` | `swatch=#a,#b,#c` | a colour strip |
| `type` | `font=<family>` `sample="Aa"` | the sample set in that family |
| `card` | -- | label + hint in a grid, no media |

```anvil
@gallery id=palette render=swatch select=one
? Which palette?
- ink  | Ink and paper | warm, printed | swatch=#111111,#f5f2ea,#c8452d
- volt | Volt          | loud, black   | swatch=#0a0a0a,#e6ff00,#8a8a8a
```

`img`, `swatch` and `font` land in `src` and `style` attributes, so they are
**allowlisted, not escaped** (§10.3). Fonts must be loaded before the card
paints or the human judges Helvetica three times.

### 5.3 `@input`

```anvil
@input id=company submit="That's us"
? Tell me who you are
_ legal*  | text     | Legal name      | Gate Industries Ltd
_ site    | url      | Current website | https://…
_ token   | secret   | API key
_ context | longtext | Anything I should know
```

Field row: `_ name[*] | type | Label | placeholder`. Trailing `*` means required.

| Type | Control |
|---|---|
| `text` | single-line input |
| `longtext` | textarea, 3 rows |
| `number` | numeric input |
| `bool` | a switch |
| `secret` | **masked** (`type=password`), value never reaches the transcript (§7.6) |
| `path` | monospace text input |
| `url` | `type=url` |
| `date` | native date picker |

### 5.4 `@code`

The only way to put a verbatim literal *inside* a block.

```anvil
@code lang=ts label="The handler"
~~~
export function handle(x: string) {
  return x.trim()
}
~~~
```

- `lang=` drives highlighting; unknown or absent renders plain, never throws.
- No sigil parsing happens inside the literal.
- An unclosed `~~~` closes at end of fence, so the parser stays total.

### 5.5 `@note`

```anvil
@note tone=warn
> Staging shares the prod Postgres. **Migrations you run there are real.**
```

`tone` is `info` (default), `warn`, `danger`. No id, no interaction, no stamp.

The body is **markdown** -- bold, links, inline code, lists. Two constraints
that come with that (see [anvil-note-markdown](../.rclaude/project/cards/anvil-note-markdown.md)):
it must reuse the app's hardened `marked` config, which escapes raw HTML; and it
needs a recursion depth guard, because a note containing an ` ```anvil ` fence
would otherwise re-enter the renderer forever.

A note also carries its own parse warnings **inside** its tinted box. It has no
frame to hang them off, so a sibling warning would float naked in the transcript.

### 5.6 `@upload`

The one block that carries bytes.

```anvil
@upload id=assets accept="pdf,png,svg,zip" max=25mb multiple
? Send me anything you already have
: Logo files, a brand guide, screenshots. Ugly is fine.
```

**The rule that makes this useful instead of decorative:** an uploaded file is
attached to the synthesised turn as a real attachment, in whatever form the
model transport already accepts. The stamp names it; the attachment carries it.
If a PDF arrives and the agent cannot read it, the upload block is a lie.

Stamps on **submit**, not on drop (§7.4).

### 5.7 `@link`

```anvil
@link id=refs multiple submit="These are the ones"
? Anything out there you want this to feel like?
```

The client fetches an OG preview per URL and folds title and description into
the stamp, so the agent gets the metadata without spending a tool call. A failed
fetch carries the bare URL and `fetched="no"` -- never block the human on
someone else's slow server.

### 5.8 `@scale`

```anvil
@scale id=tone steps=5
? Set the dials
% formal | Formal | Playful | 2
% dense  | Dense  | Airy    | 3
```

`% name | leftPole | rightPole | default`. `steps` (default 5, range 2-11) is
how many notches; the stamp reports both the notch and a normalised `0..1`.

Note the poles are what the human reads; the `name` is the machine key and is
currently not rendered. That is fine when poles differ and ambiguous when they
repeat -- see [anvil-unrendered-attrs](../.rclaude/project/cards/anvil-unrendered-attrs.md).

### 5.9 `@order`

```anvil
@order id=priorities
? Drag these into the order you would actually defend
- speed | Ship fast
- craft | Get it exactly right
```

Up/down buttons alongside the drag, always. **Drag-only ranking is an
accessibility failure** and is unusable on touch.

### 5.10 `@example`

A loaded gun for an ASK block.

```anvil
@example id=ex-typical for=company label="Roughly this much detail"
= legal=Northbound Tooling Ltd
= site=https://northbound.tools
```

- `Use this` fills the target and **nothing else**. No submit, no stamp, no tag.
- Targeting a `@choice`/`@gallery` pre-selects rows without stamping them.
- **An example dies with its target.** The moment the target stamps, every
  example pointing at it goes read-only. A live "Use this" next to a frozen
  block is a lie about what is possible.

### 5.11 `@void`

```anvil
@void id=mood reason="you described it in words instead"
```

Renders the target struck-through and inert. **Not an unstamp** -- a voided
block can never be answered, it just stops pretending it can be.

Emit it the moment the conversation overtakes an unanswered block. A stale live
widget three screens up is the single most annoying failure mode of inline UI.

---

## 6. The stamp

### 6.1 Shape

```xml
<stamp block="…" kind="…" [payload attributes…]>
  [optional child elements]
  A sentence a human would have typed.
</stamp>
```

- **Attributes are the truth.** Parse those.
- **The body is the courtesy**, so the transcript reads like a conversation and
  a model that ignores XML entirely still gets the gist.
- One tag per block; several answered blocks means several tags, in touch order.
- The client writes it. The agent never does.

Named `<stamp>` and **not** `<input>`: `<input>` collides with a real HTML
element, which a renderer or a model could plausibly confuse.

### 6.2 Per block

```xml
<!-- @choice select=one -->
<stamp block="project-kind" kind="choice" value="product" label="Product UI">
It is a product UI.
</stamp>

<!-- @choice / @gallery select=many -->
<stamp block="mood" kind="gallery" values="ed,br" labels="Editorial,Brutal">
I picked Editorial and Brutal.
</stamp>

<!-- @input -->
<stamp block="company" kind="input">
  <field name="legal">Gate Industries Ltd</field>
  <field name="token">••••••</field>
I filled in the company details.
</stamp>

<!-- @upload -- files are ALSO attached to this turn as real parts -->
<stamp block="assets" kind="upload" count="2">
  <file name="brandbook.pdf" mime="application/pdf" size="2451920" pages="48" ref="blob_7f3ac91"/>
  <file name="logo.svg" mime="image/svg+xml" size="14204" ref="blob_c02de5"/>
I uploaded the brand book and the logo.
</stamp>

<!-- @link -->
<stamp block="refs" kind="link" count="1">
  <url href="https://linear.app" fetched="yes" title="Linear" desc="…"/>
These are the ones.
</stamp>

<!-- @scale -->
<stamp block="tone" kind="scale" steps="5">
  <dial name="formal" value="2" norm="0.25" poles="Formal|Playful"/>
</stamp>

<!-- @order -->
<stamp block="priorities" kind="order" values="craft,speed,cost">
Craft, then speed, then cost.
</stamp>

<!-- skipped / expired -->
<stamp block="refs" kind="link" skipped="yes">Skipped that one.</stamp>
<stamp block="mood" kind="gallery" expired="yes">That one timed out.</stamp>
```

Every tag may also carry `at=` and, where more than one human can act, `by=`.
Always include `label`/`labels` alongside `value`/`values` -- future-you
summarising this will not remember what `br` meant.

### 6.3 It renders as the stamp, not as a bubble

The tag is a real user turn in the agent's context. In the **UI** it renders as
the stamped block, and nowhere else. A duplicate "you chose Editorial" bubble is
noise, and worse, it separates the answer from the question it answered.

### 6.4 Free text still works

The composer never goes away. A human who ignores a block and types prose has
answered it. **Design every block so that "never answered" is survivable** --
most of them will not be. That is what `@void` is for.

---

## 7. The stamp lifecycle

### 7.1 The five laws

```
   ┌────────────────────────────────────────────────────────────────────┐
   │  I.    A click stamps the block, forever. There is no unstamp      │
   │        verb, in the DSL, in the API, or in the database.           │
   │                                                                    │
   │  II.   The stamp lives on the server, keyed by block id. What the  │
   │        client holds is a cache, and it is allowed to be wrong.     │
   │                                                                    │
   │  III.  One stamp per block id. The second is REFUSED, not queued   │
   │        and not overwritten.                                        │
   │                                                                    │
   │  IV.   A stamped block still renders in full -- the answer, the    │
   │        rejected options, who, and when. Never collapsed to text.   │
   │                                                                    │
   │  V.    To change an answer, the agent asks again in a NEW block.   │
   │        History is append-only.                                     │
   └────────────────────────────────────────────────────────────────────┘
```

### 7.2 State machine

```
                        ┌─────────┐
                        │  open   │
                        └────┬────┘
                             │
        ┌────────────────────┼────────────────────┐
        │ click              │ expires            │ @void
        ▼                    ▼                    ▼
   ┌─────────┐          ┌─────────┐          ┌─────────┐
   │ pending │          │ expired │          │  void   │
   └────┬────┘          └─────────┘          └─────────┘
        │                         ┌─────────┐
        ├── server ack ─────────► │ stamped │
        │                         └─────────┘
        │
        └── nak / timeout ──────►  back to open, with an error strip

   stamped, expired and void are ABSORBING. Nothing leaves them.
```

`pending` exists so a click feels instant on a bad connection. **Never
optimistically render `stamped`** -- law II says the server decides, and a stamp
you have to take back is worse than a spinner.

### 7.3 Idempotency

Every submission carries `(blockId, nonce)`. The server keeps the first record
per `blockId` and returns it for every later attempt. One stamp results from all
four of: an impatient double-click, two open tabs, a websocket reconnect
replaying its outbox, and a retry after a timeout that had actually succeeded.

A losing attempt gets `409` plus the winning record. **Do not surface an error**
-- the user's intent was satisfied.

### 7.4 Uploads

An upload block stamps on **submit**, not on drop. Bytes go to blob storage
first; the stamp and the tag land only once every file has a ref. A
half-uploaded file must never produce a tag, or the agent gets a `ref` that
404s. If one file of three fails, the block stays `open` with that row marked
failed. Partial success is not success.

### 7.5 Expiry is server-enforced

`expires=15m` greys the block client-side **and** is checked on the server. A
client with a wrong clock, or a tab asleep for six hours, must not be able to
land an answer on a stale question.

### 7.6 Reload safety and secrets

On mount a block knows nothing. Until resolutions arrive it renders `open` but
**inert** -- visible, not clickable, no spinner. A block that flashes
clickable-then-stamped on every reload trains people to click fast, which is
exactly the reflex you do not want on a `danger` block.

A `secret` field goes up once, lands wherever secrets land, and is replaced by
`"••••••"` in the stamp record, the rendered receipt, and the tag. The
transcript is a permanent artifact.

---

## 8. Security

Both of these were **missing from the first draft of this spec**. Both have
working precedent in `dialog` that should be ported rather than reinvented.

### 8.1 A stamp is untrusted input

Stamp values are attacker-influenced free text: anyone with interact permission
typed them. Handing that to a model as an ordinary user turn is worse than
dialog's exposure, not equal to it, **because ANVIL text looks like the agent's
own markdown.**

`src/shared/dialog-event-frame.ts` already solves this:

- wraps the payload as `<channel sender="dialog-untrusted">`,
- fences the values as quoted JSON and explicitly labels them DATA, not
  instructions (there is a red-team note, R2#2, on exactly this),
- stays pure and side-effect-free so the delivery path and its tests share one
  framing.

ANVIL mirrors it with `sender="anvil-untrusted"`.

### 8.2 Stamping is permission-gated

A read-only share viewer must not be able to stamp a block. `dialog:interact`
exists for exactly this, and `src/broker/dialog-interact-guard.test.ts` asserts
that **`chat` permission alone does not grant it**. Do not reuse `chat`.

Enforcement is server-side on the stamp write. Hiding the controls client-side
is cosmetic.

### 8.3 Agent-authored values in attribute position

`swatch`, `font` and `img` land in `style` and `src` attributes, where escaping
is not sufficient. They are **allowlisted**: hex only, a conservative family
name pattern, `http(s)` only. A value that fails is dropped, not escaped.

This is implemented and tested today.

---

## 9. Scenario: onboarding a new client

The shape to aim for, abbreviated. Full worked version in git history.

**Turn 1** -- `@input` for who they are, with an `@example` beside it.

**Turn 2** -- `@choice` for what is being built, plus a `@scale` for pressure
(when / scope / money). The agent now knows "big, fast, not much money" and can
say something useful about that *before* asking anything else.

**Turn 3** -- the design language, in one coherent act: `@gallery render=image`
moodboard, `@gallery render=swatch` palette, `@gallery render=type` typeface,
and a `@scale` of tone dials. Four blocks in one turn is the **ceiling**, and it
only works because they are one act and each costs a glance.

**Turn 4** -- `@upload` for existing assets and `@link` for references. Late
enough to be earned; nobody digs through Dropbox for a robot they have exchanged
two sentences with.

**Turn 5** -- the agent notices the 2019 brand book says "warm, human" and the
human just picked black, acid yellow and a monospace, and asks **which company
is true now.** This turn is worth the other five combined.

**Turn 6** -- the brief, and the only `danger` block in the interview, on the
one thing with a consequence.

### Interview rules that fall out of this

1. **Never more than one turn ahead.** Ask, read, react, then ask. An interview
   that emits all eight blocks at once is a form with extra steps.
2. **Cheap things in bulk, expensive things alone.**
3. **React to what came back before asking the next thing.** That single
   sentence is what makes it an interview.
4. **Contradictions are the deliverable.** Hunt for them.
5. **One `danger` per interview**, at the end, on the thing with a consequence.
   If everything is loud, nothing is.
6. **Make every block skippable in practice.** Someone will type prose instead.

---

## 10. Implementation

### 10.1 Files

```
   web/src/components/anvil/
     types.ts     AnvilDoc, AnvilBlock, AnvilKind, field/option/dial shapes
     parse.ts     parseAnvil(src, opts): AnvilDoc  -- line dispatch, total
     rows.ts      the -, _ and % row parsers
     icons.ts     name -> inline SVG registry
     blocks.ts    per-kind body renderers + submitBar + warnings
     render.ts    the shell, the kind map, renderAnvilFence entry point
```

The renderer emits an **HTML string**, not React, because that is how this
transcript already renders fences: `marked` produces HTML, then post-mount
hydration handles mermaid and shiki. Matching the existing pattern leaves the
hot path untouched and skips React root lifecycle entirely.

The shell owns all chrome -- prompt, subtext, warnings, submit, footer -- so
ordering is fixed once for every kind. Body renderers return content only.

### 10.2 The parser contract

`parseAnvil` is **total**. It has no throw path. An LLM will eventually emit a
half-finished fence mid-stream, and a thrown parse error inside a transcript
renderer is a white screen for the entire conversation.

| Malformed input | Behaviour |
|---|---|
| unknown `@kind` | render as a warned `@note`, keep raw text |
| unknown leading sigil | treat as prose, append to the prompt |
| line before any `@` | implicit `@note` |
| duplicate `id` in one doc | second gets a suffix, warn |
| missing `id` | derive from content: FNV over the normalised body |
| unclosed `~~~` | close at end of fence |
| unclosed fence (streaming) | render what parsed, mark `partial`, **suppress interaction** |
| `@gallery` row with no `img=` | fall back to a placeholder for that row only |
| `> 12` options | render all of them plus a warn. Never truncate. |
| out-of-range `steps` / dial default | clamp, warn |

The derived-id rule matters more than it looks: it must be stable across
re-renders and reloads, so it can only depend on content, **never on array
position** in a list that streaming might reorder.

**Streaming:** while the message is still arriving, every block renders inert. A
block that becomes clickable before its last option has streamed in is how
someone answers a question they have not finished reading.

### 10.3 Test posture

The load-bearing test is a fuzz over **every prefix of every fixture** -- an LLM
emits these token by token, so every truncation is a real input the renderer
will see. Plus injection cases for the three attribute-position values, and one
assertion that **no non-ASCII reaches the emitted markup at all** (the
regression guard for a class of tofu bug, not just its instances).

---

## 11. Rendering and interaction rules

Each of these has cost someone a bug.

1. **Never autofocus.** The composer owns the caret. An inline block that grabs
   focus eats the sentence the human was typing.
2. **Height must not change on stamp.** Reserve the space. A block shrinking
   three screens up yanks the scroll position out from under the reader.
3. **No layout animation.** Opacity and colour only; drop even those under
   `prefers-reduced-motion`.
4. **Reserve image space before load.** A gallery that pops in at natural height
   reflows the whole transcript.
5. **Icons are vectors, never glyphs.** A text icon falls out of the monospace
   stack into a fallback font and draws a tofu box.
6. **Number keys 1-9** select when focused; `Enter` submits; arrows drive
   `@scale`; `Escape` does nothing -- there is nothing to dismiss and people
   press it reflexively.
7. **Real `<button>` elements.** `select=one` is a `role="radiogroup"`,
   `select=many` a `<fieldset>` of checkboxes.
8. **Stamped leaves the tab order** but stays readable to a screen reader.
9. **Full width of the bubble, not the viewport.** ANVIL is part of a message.
10. **Mobile:** 44px hit targets, hints wrap rather than truncate, gallery goes
    two-up, `@upload` offers the camera.
11. **Drag is never the only path.**
12. **Single-select never gets a submit button.** The click is the answer; a
    button would be a second, meaningless step.

---

## 12. Authoring rules for the agent

**Do**

- Put the block where the question naturally falls in the sentence.
- Write labels a human scans in one pass. `Product UI`, not `Option B`.
- Use the hint column for the *consequence*, not a restatement.
- Reach for `@gallery` the moment the answer is aesthetic. Six images beat six
  adjectives.
- Reach for `@scale` when the answer is a dial. "How formal" is never a
  multiple-choice question.
- Use `@example` whenever a field has a non-obvious shape.
- Set `expires` on anything time-sensitive; `@void` anything overtaken.
- Give reversible choices an exit row. A two-option block with no exit is a
  trap, and people click it to make it go away.

**Do not**

- Do not use a block for something you could infer and state. A widget for a
  question you already know the answer to is friction dressed as courtesy.
- Do not exceed about six options, or eight gallery cards.
- Do not put a `danger` block mid-paragraph. Give it its own beat.
- Do not emit a wall of unrelated blocks. Four is the ceiling, and only when
  they are one coherent act.
- Do not assume an answer will come.
- Do not reference a block's answer in text written *before* it exists.
- Do not write `<stamp>` tags. That channel belongs to the client.

---

## 13. Failure modes, ranked by how much they hurt

| # | Failure | Guard |
|---|---|---|
| 1 | Parser throws on a partial stream | total parser (§10.2) + error boundary per message |
| 2 | Stamp derived from client state | law II, resolutions from the server (§7.6) |
| 3 | No idempotency key | `(blockId, nonce)`, first wins, `409` for the rest (§7.3) |
| 4 | Stamp text handed to the model unframed | untrusted channel wrapper (§8.1) |
| 5 | A read-only viewer can stamp | server-side permission gate (§8.2) |
| 6 | Upload tag emitted before bytes land | stamp on submit, not on drop (§7.4) |
| 7 | Uploaded PDF not attached to the turn | attach real parts, not just a filename (§5.6) |
| 8 | Block autofocuses | §11.1, no exceptions |
| 9 | Height changes on stamp, or images pop in | §11.2, §11.4 |
| 10 | Unstable derived ids | hash content, never index (§10.2) |
| 11 | Secret echoed into the tag | mask server-side (§7.6) |
| 12 | Stale blocks left live | `expires` + `@void` (§5.11) |
| 13 | Answer also posted as a chat bubble | render as the stamp only (§6.3) |
| 14 | Example still clickable after target stamps | examples die with their target (§5.10) |
| 15 | Agent value in a style/src attribute | allowlist, do not escape (§8.3) |
| 16 | Tags hand-rolled per block | one serializer, one escaping policy |

---

## 14. Reference card

```
   ┌── ASK ───────────────────────────────────────────────────────────────┐
   │ @choice   text options            @upload  files, real attachments   │
   │ @gallery  image|swatch|type|card  @link    paste URL + fetched card  │
   │ @input    typed fields            @scale   sliders between poles     │
   │                                   @order   drag to rank              │
   │ common: id= select=one|many min= max= submit= icon= expires=         │
   │         optional danger phrase=                                      │
   ├── SHOW / CONTROL ────────────────────────────────────────────────────┤
   │ @note tone=info|warn|danger (markdown body)                          │
   │ @code lang= label=   @example for=<id>   @void id= reason=           │
   ├── LINES ─────────────────────────────────────────────────────────────┤
   │ ? prompt          : subtext          # comment (never rendered)      │
   │ - value | Label | hint | img= swatch= font= sample=   (! = danger)   │
   │ _ name[*] | type | Label | placeholder                               │
   │ % name | leftPole | rightPole | default                              │
   │ = field=value     > prose (markdown)     ~~~ … ~~~  literal          │
   ├── FIELD TYPES ───────────────────────────────────────────────────────┤
   │ text  longtext  number  bool  secret  path  url  date                │
   ├── STAMP ─────────────────────────────────────────────────────────────┤
   │ <stamp block="…" kind="…" value(s)= label(s)= [at= by=]>             │
   │   <field name=…>  <file name= mime= ref=>  <url href= title=>        │
   │   <dial name= value= norm= poles=>                                   │
   │   A sentence a human would have typed.                               │
   │ </stamp>                                                             │
   │ attributes are the TRUTH · the sentence is the COURTESY              │
   ├── STATES ────────────────────────────────────────────────────────────┤
   │ open → pending → stamped        open → expired        open → void    │
   │ stamped, expired and void are absorbing. Nothing leaves them.        │
   └──────────────────────────────────────────────────────────────────────┘
```

---

## 15. What is left

Tracked on the board under
[anvil-epic](../.rclaude/project/cards/anvil-epic.md). Rough order:

1. **`@code`** -- the `~~~` lexer path, which `@example` also needs.
2. **`@note` renders markdown** -- reuse the hardened `marked`, add a depth guard.
3. **The stamp store** -- server-held, idempotent, absorbing. This is the
   keystone; everything interactive depends on it.
4. **`<stamp>` wire format** -- one serializer, one escaping policy.
5. **Untrusted framing + permission gate** -- both before any real traffic.
6. **`@upload`** -- the biggest single block, because of the attachment path.
7. **`@link`, `@order`, `@example`, `@void`.**
8. **The unrendered attributes** -- `danger`, `phrase`, `expires`, `optional`,
   `min`/`max`. Either they draw something or the parser warns. Silent
   acceptance is the bug.
9. **The kitchen-sink fixture** -- it found six real defects in one pass and has
   earned a permanent home.

---

```
      ╭──────────────────────────────────────────────────────────────╮
      │   ┌───────┐                                                  │
      │   │ ◉   ◉ │    Rich going down. Structured text coming up.   │
      │   │   ‿   │    Ask it inline. Ask it once.                   │
      │   └──┬─┬──┘    The click is the signature.                   │
      │      ╰─╯                                                     │
      ╰──────────────────────────────────────────────────────────────╯
```
