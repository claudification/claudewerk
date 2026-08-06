# MIL -- Molly Inline Language

```
      ╭──────────────────────────────────────────────────────────────╮
      │   ┌───────┐                                                  │
      │   │ ◉   ◉ │    M I L                                         │
      │   │   ⌄   │    Molly Inline Language                         │
      │   └──┬─┬──┘    rich interfaces INSIDE the transcript.        │
      │      ╰─╯       every touch compiles down to structured text. │
      ╰──────────────────────────────────────────────────────────────╯
```

> **To:** MOLLY @ GATE\
> **From:** the CLAUDEWERK side\
> **Status:** specification, v1. Self-contained -- you need nothing else to build this.\
> **Scope:** a text DSL an agent emits mid-sentence, the React components that render
> it as real UI inline in the chat stream, and the structured-text tag every
> interaction compiles back into.

---

## 0. Sixty seconds

MIL has exactly two halves.

````
   ┌──────────────────────────┐                ┌──────────────────────────┐
   │  DOWN: a fenced block    │                │  UP: a structured tag    │
   │  Molly writes markdown.  │  ─── human ──► │  the client writes text. │
   │  The client renders it   │      clicks    │  Molly reads text.       │
   │  as REAL UI.             │                │                          │
   └──────────────────────────┘                └──────────────────────────┘
              ```mil                                     <input …>
````

Down, mid-sentence, in an ordinary message:

````markdown
Nice. Which of these feels like you?

```mil
@gallery id=mood select=many max=2
? Pick the ones that feel right
- ed  | Editorial | dense, warm   | img=https://cdn.gate/m/ed.jpg
- sw  | Swiss     | airy, cold    | img=https://cdn.gate/m/sw.jpg
- br  | Brutal    | loud, black   | img=https://cdn.gate/m/br.jpg
```
````

That renders as a row of clickable image cards. The human clicks two and confirms.
The cards lock -- the picked ones lift, the rest fade, forever.

Up, into your context, as a plain user turn:

```xml
<input block="mood" kind="gallery" values="ed,br" labels="Editorial,Brutal">
I picked Editorial and Brutal.
</input>
```

**That tag is the entire integration.** No tool calls, no widget runtime, no event
bus reaching into your loop. You emit markdown, you read text. Everything between
is the client's problem.

The attributes are the truth. The sentence inside is the courtesy -- it exists so
the transcript still reads like a conversation six months from now.

---

## 1. The axiom, and what falls out of it

> A chat transcript is an append-only record of things that happened.\
> A widget that can be re-answered turns that record into a lie.

Hence:

| MIL is | MIL is not |
|---|---|
| Rich UI rendered **inside** a message bubble | A modal, drawer, overlay or popover |
| Answered exactly once, then frozen in place | A form you can revise |
| Compiled to text on the way up | An event stream you subscribe to |
| A closed set of nine blocks | An extensible widget framework |
| Authored by an LLM mid-sentence, no escaping pain | JSON you have to serialise carefully |

If you want a back-button, a re-open, a live-updating value, or a block that
mutates after it is drawn: you want a different tool. MIL's value is that the
transcript stays honest.

---

## 2. The vocabulary

```
   ASK  (produce an <input> tag, then lock)
     @choice    one-of-N or many-of-N, text rows
     @gallery   the same, but visual: images, swatches, typefaces, cards
     @input     typed fields -- text, number, bool, secret, path
     @upload    file drop. PDF, images, zips. Real attachments, not links.
     @link      paste a URL, get a fetched preview card
     @scale     one or more sliders between two named poles
     @order     drag N items into a ranking

   SHOW (never produce a tag, never lock)
     @note      prose, hints, warnings
     @example   a canned value that fills an ASK block

   CONTROL
     @void      retract an unanswered block you have moved past
```

Nine blocks and one directive. That is the whole surface. Almost everything you
will be tempted to add (`@confirm`, `@yesno`, `@palette`, `@rate`, `@multi`) is one
of these with an attribute set.

---

## 3. Grammar

Line-oriented. One level of nesting, never more. Leading whitespace is insignificant.

### 3.1 Sigils

| Sigil | Means | Appears in |
|---|---|---|
| `@` | block header: `@kind key=value key="quoted value"` | starts every block |
| `?` | the prompt. Repeatable; lines join with a newline. | all |
| `:` | subtext / help, rendered smaller under the prompt | all |
| `-` | an option row | `@choice` `@gallery` `@order` |
| `_` | a field row | `@input` |
| `%` | a scale row | `@scale` |
| `=` | a prefill row: `field=value` | `@example` |
| `>` | prose line | `@note` |
| `#` | comment. Parsed, never rendered, never sent. | anywhere |
| `~~~` | literal fence, opens and closes a verbatim body | `@example` |

A line starting with none of the above is treated as prose and appended to the
current prompt. **Deliberate:** an agent that forgets a sigil gets slightly-wrong
rendering, never a crash.

### 3.2 Shape

```ebnf
doc      = block+ ;
block    = header , line* ;
header   = "@" , kind , { ws , attr } , NL ;
attr     = key , [ "=" , ( bareword | quoted ) ] ;      (* bare attr = true *)
option   = "-" , [ "!" ] , value , { "|" , cell } , NL ;
cell     = label | hint | ( key , "=" , value ) ;       (* img= swatch= font= *)
field    = "_" , name , [ "*" ] , "|" , type , { "|" , cell } , NL ;
scale    = "%" , name , "|" , leftPole , "|" , rightPole , [ "|" , default ] , NL ;
```

Pipes are the only column separator; pad them for readability, the parser trims.
A literal pipe inside a label is `\|`. Trailing `key=value` cells are unordered,
so `| img=… | Editorial |` and `| Editorial | img=…` both work.

---

## 4. The blocks

Every ASK block shares these attributes:

| Attribute | Default | Meaning |
|---|---|---|
| `id` | derived (§8.4) | stable identity, and the `block=` in the answer tag |
| `select` | `one` | `one` locks on click. `many` gives checkboxes plus a submit. |
| `min` `max` | -- | with `select=many`, bounds enforced before submit arms |
| `submit` | `"Confirm"` | button label |
| `expires` | none | `30s` `15m` `2h`. Server-enforced (§6.5). |
| `optional` | off | renders a `Skip` affordance that still emits a tag |
| `danger` | off | red framing plus a second deliberate click |
| `phrase` | -- | with `danger`: type this exact string to arm the button |

### 4.1 `@choice` -- text options

```mil
@choice id=project-kind
? What are we actually building?
: If it is more than one, pick the one that pays for the others.
- site    | Marketing site    | pages, no login
- product | Product UI        | accounts, state, real users
- brand   | Brand system only | identity, no build
- unsure  | Not sure yet      | let us work it out together
```

```
   ╭─ ? What are we actually building? ─────────────────────────╮
   │  If it is more than one, pick the one that pays for the    │
   │  others.                                                   │
   │                                                            │
   │    [1]  Marketing site      pages, no login                │
   │    [2]  Product UI          accounts, state, real users    │
   │    [3]  Brand system only   identity, no build             │
   │    [4]  Not sure yet        let us work it out together    │
   │                                                            │
   ╰──────────────────────────────────── open · 15m left ───────╯
```

Locked, at **exactly the same height** (§9.2):

```
   ╭─ ? What are we actually building? ─────────────────────────╮
   │  If it is more than one, pick the one that pays for the    │
   │  others.                                                   │
   │                                                            │
   │         Marketing site      pages, no login                │  ← 40%
   │    ✓    Product UI          accounts, state, real users    │  ← accent
   │         Brand system only   identity, no build             │  ← 40%
   │         Not sure yet        let us work it out together    │  ← 40%
   │                                                            │
   ╰──────────────────────────── locked · Jonas · 14:02:11 ─────╯
```

Never collapse a locked choice to one line. The rejected rows are part of the
record -- they show what the human was choosing *between*.

Prefix a value with `!` to mark that single row destructive:
`- !wipe | Start from scratch | we bin the existing brand`.

### 4.2 `@gallery` -- the visual one

Same semantics as `@choice`, different renderer. This is your design-language
workhorse.

```mil
@gallery id=mood render=image select=many min=1 max=3
? Which of these feels like you?
: Gut reaction. Do not think about it too hard.
- ed | Editorial | dense, warm, printed   | img=https://cdn.gate/m/ed.jpg
- sw | Swiss     | airy, cold, gridded    | img=https://cdn.gate/m/sw.jpg
- br | Brutal    | loud, black, unsubtle  | img=https://cdn.gate/m/br.jpg
- or | Organic   | soft, green, handmade  | img=https://cdn.gate/m/or.jpg
```

```
   ╭─ ◫ Which of these feels like you? ───────────── pick 1 to 3 ─╮
   │  Gut reaction. Do not think about it too hard.               │
   │                                                              │
   │   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
   │   │▓▓▒▒░░▒▒▓▓│  │░░░░░░░░░░│  │▓▓▓▓▓▓▓▓▓▓│  │▒▓▒▓▒▓▒▓▒▓│     │
   │   │▒▒▓▓▒▒▓▓▒▒│  │░░ ▁▁▁▁ ░░│  │▓▓ ████ ▓▓│  │▓▒▓▒▓▒▓▒▓▒│     │
   │   │▓▓▒▒░░▒▒▓▓│  │░░░░░░░░░░│  │▓▓▓▓▓▓▓▓▓▓│  │▒▓▒▓▒▓▒▓▒▓│     │
   │   └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
   │    [1]Editorial  [2]Swiss      [3]Brutal     [4]Organic      │
   │     dense, warm   airy, cold    loud, black   soft, green    │
   │                                                              │
   │                                          [ Confirm ]         │
   ╰──────────────────────────────────────────── open ────────────╯
```

`render=` picks the card body. One block, four renderers:

| `render` | Cell attribute | Card shows |
|---|---|---|
| `image` (default) | `img=<url>` | the image, 4:3, object-fit cover |
| `swatch` | `swatch=#hex` or `swatch=#a,#b,#c` | a colour chip or a palette strip |
| `type` | `font=<family>` `sample="Aa Bb"` | the sample set in that family |
| `card` | -- | label + hint only, but in a grid, not a list |

Design-language recipes:

```mil
@gallery id=palette render=swatch select=one
? Which palette?
- ink   | Ink and paper | swatch=#111111,#f5f2ea,#c8452d
- deep  | Deep water    | swatch=#0b2540,#1d7a8c,#e8f1f2
- clay  | Clay          | swatch=#3d2b1f,#c67c4e,#f2e8dc
```

```mil
@gallery id=typeface render=type select=one
? Pick a voice
- gt  | GT Sectra     | editorial serif  | font="GT Sectra" | sample="Gate Industries"
- inter | Inter       | neutral grotesk  | font="Inter"     | sample="Gate Industries"
- mono  | Berkeley    | technical mono   | font="Berkeley Mono" | sample="Gate Industries"
```

```
   ╭─ ◫ Pick a voice ───────────────────────────────────────────╮
   │   ┌────────────────────────┐  ┌────────────────────────┐   │
   │   │  Gate Industries       │  │  Gate Industries       │   │
   │   │  ───────────────────   │  │  ───────────────────   │   │
   │   │  [1] GT Sectra         │  │  [2] Inter             │   │
   │   │      editorial serif   │  │      neutral grotesk   │   │
   │   └────────────────────────┘  └────────────────────────┘   │
   ╰──────────────────────────────────────────── open ──────────╯
```

Fonts must be loaded before the card paints, or the human judges Helvetica three
times. Render the card skeleton until `document.fonts.ready` resolves for that
family, and fall back to the image renderer if the family never loads.

### 4.3 `@input` -- typed fields

```mil
@input id=company submit="That's us"
? Tell me who you are
_ legal*  | text     | Legal name        | Gate Industries Ltd
_ site    | url      | Current website   | https://…
_ people  | number   | How many of you
_ contact*| text     | Who do I talk to  | name + email
_ nda     | bool     | We will need an NDA first
_ context | longtext | Anything I should know before we start
```

Field row: `_ name[*] | type | Label | placeholder`. Trailing `*` means required.
Label defaults to the name, title-cased.

| Type | Renders as |
|---|---|
| `text` | single-line input |
| `longtext` | textarea, 3 rows, autogrows to 10 |
| `number` | numeric input, `inputmode="decimal"` |
| `bool` | a switch |
| `secret` | masked. Value never reaches the transcript (§6.7). |
| `path` | monospace text input |
| `url` | `type=url`, validated on blur |
| `date` | native date picker |

```
   ╭─ ? Tell me who you are ────────────────────────────────────╮
   │  Legal name                                                │
   │  ┌──────────────────────────────────────────────────────┐  │
   │  │ Gate Industries Ltd                                  │  │
   │  └──────────────────────────────────────────────────────┘  │
   │  Current website                          (optional)       │
   │  ┌──────────────────────────────────────────────────────┐  │
   │  │ https://gate.industries                              │  │
   │  └──────────────────────────────────────────────────────┘  │
   │  We will need an NDA first                (  ●)            │
   │                                                            │
   │                                        [ That's us ]       │
   ╰──────────────────────────────────────────── open ──────────╯
```

### 4.4 `@upload` -- files, for real

The one block that carries bytes. Everything else is text.

```mil
@upload id=assets accept="pdf,png,svg,ai,zip" max=25mb multiple
? Send me anything you already have
: Logo files, a brand guide, screenshots of the old site. Ugly is fine.
```

| Attribute | Default | Meaning |
|---|---|---|
| `accept` | any | comma list of extensions or mime prefixes |
| `max` | `25mb` | per file |
| `multiple` | off | allow more than one |
| `count` | -- | `count=3` requires exactly three |
| `paste` | on | Cmd+V an image straight into the drop zone |

```
   ╭─ ⇪ Send me anything you already have ──────────────────────╮
   │  Logo files, a brand guide, screenshots of the old site.   │
   │  Ugly is fine.                                             │
   │                                                            │
   │   ┌───────────────────────────────────────────────────┐    │
   │   │           drop files, or click to browse          │    │
   │   │       pdf · png · svg · ai · zip  ·  25 MB each   │    │
   │   └───────────────────────────────────────────────────┘    │
   │                                                            │
   │   ▤ gate-brandbook-2024.pdf   2.4 MB   ████████░░  78%     │
   │   ▦ logo-lockup.svg            14 KB   done          ✓     │
   │                                                            │
   │                                     [ Send 2 files ]       │
   ╰──────────────────────────────────────────── open ──────────╯
```

**The rule that makes this useful instead of decorative:** an uploaded file is
attached to the synthesised user turn as a real attachment, in whatever form your
model transport already accepts (image parts, document parts, a fetchable blob
ref). The `<input>` tag names it; the attachment carries it. If a PDF arrives and
you cannot read it, the upload block is a lie.

Locked, it renders as a static file list with a preview thumbnail per file and no
drop zone.

### 4.5 `@link` -- paste a URL, get a card

```mil
@link id=refs multiple submit="These are the ones"
? Anything out there you want this to feel like?
: Competitors, sites you love, sites you hate. Hate is useful.
```

The client fetches an OG preview per URL and folds the fetched title, description
and image into the answer tag. **You get the metadata without spending a tool
call.** If the fetch fails, the tag carries the bare URL and `fetched="no"` -- do
not block the human on someone else's slow server.

```
   ╭─ ⛓ Anything out there you want this to feel like? ─────────╮
   │  Competitors, sites you love, sites you hate. Hate is      │
   │  useful.                                                   │
   │  ┌──────────────────────────────────────────────────────┐  │
   │  │ https://…                                            │  │
   │  └──────────────────────────────────────────────────────┘  │
   │                                                            │
   │  ┌────────────────────────────────────────────────────┐    │
   │  │ ▣  Linear -- A better way to build products        │ ✕  │
   │  │    linear.app · fetched 14:02                      │    │
   │  └────────────────────────────────────────────────────┘    │
   │  ┌────────────────────────────────────────────────────┐    │
   │  │ ▣  Teenage Engineering                             │ ✕  │
   │  │    teenage.engineering · fetched 14:02             │    │
   │  └────────────────────────────────────────────────────┘    │
   │                                                            │
   │                              [ + another ]  [ These… ]     │
   ╰──────────────────────────────────────────── open ──────────╯
```

### 4.6 `@scale` -- the sliders

For everything that is a dial, not a pick. Design language lives here.

```mil
@scale id=tone steps=5
? Set the dials
% formal | Formal   | Playful | 2
% dense  | Dense    | Airy    | 3
% quiet  | Quiet    | Loud    | 4
% warm   | Cool     | Warm    | 3
```

`% name | leftPole | rightPole | default`. `steps` (default 5) is how many notches;
the answer reports both the notch and a normalised `0..1`.

```
   ╭─ ⇔ Set the dials ──────────────────────────────────────────╮
   │                                                            │
   │   Formal    ──────●──────────────────────────    Playful   │
   │   Dense     ───────────────●─────────────────    Airy      │
   │   Quiet     ─────────────────────────●───────    Loud      │
   │   Cool      ───────────────●─────────────────    Warm      │
   │                                                            │
   │                                        [ Confirm ]         │
   ╰──────────────────────────────────────────── open ──────────╯
```

Keyboard: arrows move the focused slider one notch, `Tab` moves between rows.
Touch: the whole row is the hit area, not the 12px dot.

### 4.7 `@order` -- rank them

```mil
@order id=priorities
? Drag these into the order that matters to you
- speed   | Ship fast
- craft   | Get it exactly right
- cost    | Keep it cheap
- scale   | Survive 100x growth
```

Renders as a drag list with up/down buttons as the keyboard and touch fallback
(drag-only ranking is an accessibility failure). The answer reports the final
order, top first.

### 4.8 `@note` -- prose

```mil
@note tone=warn
> Whatever you upload here lands in the client transcript permanently.
> Do not paste credentials.
```

`tone` is `info` (default), `warn`, `danger`. No id, no interaction, no lock, no
tag. Exists so you do not have to break out of the fence for one sentence.

### 4.9 `@example` -- a loaded gun for an ASK block

```mil
@example id=ex-typical for=company label="What a typical answer looks like"
: Most GATE clients fill it in about this much.
= legal=Northbound Tooling Ltd
= site=https://northbound.tools
= people=14
= contact=Ana Reis, ana@northbound.tools
```

| Attribute | Meaning |
|---|---|
| `for` | id of the ASK block it fills. **Required.** |
| `label` | title shown in the frame |
| `id` | its own id, so the answer tag can record which example was used |

```
   ╭─ ≡ What a typical answer looks like ─── fills: company ────╮
   │  Most GATE clients fill it in about this much.             │
   │                                                            │
   │    legal    Northbound Tooling Ltd                         │
   │    site     https://northbound.tools                       │
   │    people   14                                             │
   │    contact  Ana Reis, ana@northbound.tools                 │
   │                                                            │
   │                                        [ Use this ]        │
   ╰────────────────────────────────────────────────────────────╯
```

Rules:

- `Use this` **fills the target and nothing else.** It does not submit, does not
  lock, does not emit a tag. The human still presses the target's own button.
- Targeting a `@choice`/`@gallery` pre-selects rows without locking them.
- **An example dies with its target.** The moment `company` locks, every example
  pointing at it goes read-only and the button disappears. A live "Use this" next
  to a frozen block is a lie about what is possible.
- A `for` that matches nothing in the same message renders as a read-only card
  plus a parse warning. Never silently drop it.

### 4.10 `@void` -- the only retraction

```mil
@void id=mood reason="you described it in words instead, we are good"
```

Renders the target struck-through and inert, reason in the footer. This is **not**
an unlock. A voided block can never be answered; it just stops pretending it can be.

Emit `@void` the moment the conversation overtakes an unanswered block. A stale
live widget three screens up is the single most annoying failure mode of inline UI.

---

## 5. The answer tag

### 5.1 Shape

```xml
<input block="…" kind="…" [payload attributes…]>
  [optional child elements]
  A sentence a human would have typed.
</input>
```

- **Attributes are the truth.** Parse those.
- **The body is the courtesy.** It exists so the transcript reads like a
  conversation, and so a model that ignores XML entirely still gets the gist.
- One tag per block. Several blocks answered in one message means several tags,
  in the order the human touched them.
- The client writes it. You never write it. If you see one you authored, that is
  a bug in the client's echo suppression.

### 5.2 Per block

```xml
<!-- @choice select=one -->
<input block="project-kind" kind="choice" value="product" label="Product UI">
It is a product UI -- accounts, state, real users.
</input>

<!-- @choice / @gallery select=many -->
<input block="mood" kind="gallery" values="ed,br" labels="Editorial,Brutal">
I picked Editorial and Brutal.
</input>

<!-- @gallery render=swatch -->
<input block="palette" kind="gallery" value="clay" label="Clay"
       swatch="#3d2b1f,#c67c4e,#f2e8dc">
The Clay palette.
</input>

<!-- @input -->
<input block="company" kind="input">
  <field name="legal">Gate Industries Ltd</field>
  <field name="site">https://gate.industries</field>
  <field name="people">14</field>
  <field name="nda">true</field>
  <field name="context">The old site was built in 2019 and nobody remembers how.</field>
I filled in the company details.
</input>

<!-- @upload -- files are ALSO attached to this turn as real parts -->
<input block="assets" kind="upload" count="2">
  <file name="gate-brandbook-2024.pdf" mime="application/pdf" size="2451920"
        pages="48" ref="blob_7f3ac91"/>
  <file name="logo-lockup.svg" mime="image/svg+xml" size="14204" ref="blob_c02de5"/>
I uploaded the brand book and the logo lockup.
</input>

<!-- @link -->
<input block="refs" kind="link" count="2">
  <url href="https://linear.app" fetched="yes"
       title="Linear -- A better way to build products"
       desc="Linear streamlines issues, projects and roadmaps."/>
  <url href="https://teenage.engineering" fetched="no" error="timeout"/>
These are the ones.
</input>

<!-- @scale -->
<input block="tone" kind="scale" steps="5">
  <dial name="formal" value="2" norm="0.25" poles="Formal|Playful"/>
  <dial name="dense"  value="3" norm="0.50" poles="Dense|Airy"/>
  <dial name="quiet"  value="4" norm="0.75" poles="Quiet|Loud"/>
  <dial name="warm"   value="3" norm="0.50" poles="Cool|Warm"/>
</input>

<!-- @order -->
<input block="priorities" kind="order" values="craft,speed,scale,cost">
Craft first, then speed, then scale, then cost.
</input>

<!-- skipped an optional block -->
<input block="refs" kind="link" skipped="yes">
Skipped that one.
</input>

<!-- expired, emitted by the client when the human never answered in time -->
<input block="mood" kind="gallery" expired="yes">
That one timed out unanswered.
</input>
```

Every tag may also carry `at="2026-08-06T14:02:11Z"` and, when the surface has more
than one human, `by="Jonas"`. Include `label`/`labels` alongside `value`/`values`
always -- future-you summarising this conversation will not remember what `br`
meant.

### 5.3 It renders as the lock, not as a bubble

The tag is a real user turn in **your** context. In the **UI** it renders as the
lock inside the original block, and nowhere else. No second bubble.

A duplicate "you chose Editorial and Brutal" message is noise, and worse, it
separates the answer from the question it answered. Keep the raw tag available
behind a disclosure on the locked block, for the two people a year who want it.

### 5.4 Free text still works

The composer never goes away. A human who ignores a block and types
"honestly just do whatever you did for Northbound" has answered it. That is a
legitimate outcome, and it is why `@void` exists.

**Design every block so that "never answered" is a survivable continuation.**
Most of them will not be answered.

---

## 6. The lock

### 6.1 The five laws

```
   ┌────────────────────────────────────────────────────────────────────┐
   │  I.    A click locks the block, forever. There is no unlock verb,  │
   │        in the DSL, in the API, or in the database.                 │
   │                                                                    │
   │  II.   The lock lives on the server, keyed by block id. What the   │
   │        client holds is a cache, and it is allowed to be wrong.     │
   │                                                                    │
   │  III.  One answer per block id. The second is REFUSED, not queued  │
   │        and not overwritten.                                        │
   │                                                                    │
   │  IV.   A locked block still renders in full -- the answer, the     │
   │        rejected options, who, and when. Never collapsed to text.   │
   │                                                                    │
   │  V.    To change an answer, Molly asks again in a NEW block.       │
   │        History is append-only.                                     │
   └────────────────────────────────────────────────────────────────────┘
```

### 6.2 State machine

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
        ├── server ack ─────────► │ locked  │
        │                         └─────────┘
        │
        └── nak / timeout ──────►  back to open, with an error strip

   locked, expired and void are ABSORBING. Nothing leaves them.
```

`pending` exists so a click feels instant on a bad connection: the chosen row goes
optimistic immediately, everything else disables, a small spinner sits in the
footer. If the ack never lands, roll back to `open` and say why.

**Never optimistically render `locked`.** Law II says the server decides, and a
lock you have to take back is worse than a spinner.

### 6.3 Idempotency, concretely

Every submission carries `(blockId, nonce)`. The server keeps the first record it
sees per `blockId` and returns that same record for every later attempt, whatever
the nonce. One answer results from all four of:

- an impatient double-click,
- the same conversation open in two tabs,
- a websocket reconnect replaying its outbox,
- a retry after a timeout that had actually succeeded.

A losing attempt gets `409` plus the winning record, and the client renders the
winner. **Do not surface an error** -- the user's intent was satisfied.

### 6.4 Uploads and the lock

An upload block locks on *submit*, not on drop. Bytes go up first, into blob
storage; the lock and the tag land only once every file has a ref. A half-uploaded
file must never produce a tag, or you will be handed a `ref` that 404s.

If one file of three fails, the block stays `open` with that row marked failed and
a retry on it. Partial success is not success.

### 6.5 Expiry is server-enforced

`expires=15m` greys the block out client-side **and** is checked on the server. A
client with a wrong clock, or a tab that has been asleep for six hours, must not
be able to land an answer on a stale question.

When a block expires unanswered, the client emits the `expired="yes"` tag (§5.2)
exactly once. Molly should treat that as information, not as an error -- most
expired blocks mean the conversation simply went somewhere better.

### 6.6 Reload safety

On mount a block knows nothing. It asks the host for resolutions for every block
id in the message, or better, the host ships them with the transcript. Until they
arrive the block renders `open` but **inert** -- visible, not clickable, no spinner.

A block that flashes clickable-then-locked on every reload trains people to click
fast, which is precisely the reflex you do not want on a `danger` block.

### 6.7 Secrets

A `secret` field goes up once, lands wherever secrets land, and is replaced by
`"••••••"` in the lock record, the rendered receipt, and the `<input>` tag. The
transcript is a permanent artifact. Do not put an API key in it.

---

## 7. SCENARIO -- onboarding a new GATE client

The whole point, worked end to end. Molly's turns are markdown with fences; the
client's turns are `<input>` tags. Nothing else moves.

### Turn 1 -- who

> **MOLLY:** Right. I am going to ask you about eight things, and then I will
> write the brief and you can tear it apart. Start with the boring one.

````markdown
```mil
@input id=company submit="That's us"
? Who are you?
_ legal*   | text     | Legal name       | Gate Industries Ltd
_ site     | url      | Current website  | https://…
_ people   | number   | How many of you
_ contact* | text     | Who do I talk to | name + email
_ nda      | bool     | We need an NDA before we go further

@example id=ex-typical for=company label="Roughly this much detail"
= legal=Northbound Tooling Ltd
= site=https://northbound.tools
= people=14
= contact=Ana Reis, ana@northbound.tools
```
````

```xml
<input block="company" kind="input">
  <field name="legal">Gate Industries Ltd</field>
  <field name="site">https://gate.industries</field>
  <field name="people">14</field>
  <field name="contact">Jonas Frost, jonas@gate.industries</field>
  <field name="nda">false</field>
Filled it in.
</input>
```

### Turn 2 -- what, and how urgent

> **MOLLY:** Fourteen people and no NDA, good, we can move fast.

````markdown
```mil
@choice id=project-kind
? What are we actually building?
: If it is more than one, pick the one that pays for the others.
- site    | Marketing site    | pages, no login
- product | Product UI        | accounts, state, real users
- brand   | Brand system only | identity, no build
- unsure  | Not sure yet      | let us work it out together

@scale id=pressure steps=5
? And how much pressure is on it?
% when  | Whenever   | Yesterday | 3
% scope | Tiny       | Enormous  | 3
% money | Careful    | Unlimited | 2
```
````

```xml
<input block="project-kind" kind="choice" value="product" label="Product UI">
Product UI -- accounts, state, real users.
</input>
<input block="pressure" kind="scale" steps="5">
  <dial name="when"  value="4" norm="0.75" poles="Whenever|Yesterday"/>
  <dial name="scope" value="4" norm="0.75" poles="Tiny|Enormous"/>
  <dial name="money" value="2" norm="0.25" poles="Careful|Unlimited"/>
</input>
```

> Molly now knows: big, fast, and not much money. She can say something useful
> about that *before* asking anything else, which is the difference between an
> interview and a form.

### Turn 3 -- the design language

> **MOLLY:** Big, fast and cheap is two out of three at best, and I will come back
> to that. First, the fun part. Do not think, just react.

````markdown
```mil
@gallery id=mood render=image select=many min=1 max=3
? Which of these feels like you?
- ed | Editorial | dense, warm, printed  | img=https://cdn.gate/m/ed.jpg
- sw | Swiss     | airy, cold, gridded   | img=https://cdn.gate/m/sw.jpg
- br | Brutal    | loud, black, unsubtle | img=https://cdn.gate/m/br.jpg
- or | Organic   | soft, green, handmade | img=https://cdn.gate/m/or.jpg
- tr | Terminal  | mono, green on black  | img=https://cdn.gate/m/tr.jpg
- lx | Luxe      | thin serif, huge gaps | img=https://cdn.gate/m/lx.jpg

@gallery id=palette render=swatch select=one optional
? And a starting palette, if any of these are close
- ink  | Ink and paper | swatch=#111111,#f5f2ea,#c8452d
- deep | Deep water    | swatch=#0b2540,#1d7a8c,#e8f1f2
- clay | Clay          | swatch=#3d2b1f,#c67c4e,#f2e8dc
- volt | Volt          | swatch=#0a0a0a,#e6ff00,#8a8a8a

@gallery id=typeface render=type select=one optional
? A voice for the words
- sec  | GT Sectra    | editorial serif    | font="GT Sectra"    | sample="Gate Industries"
- int  | Inter        | neutral grotesk    | font="Inter"        | sample="Gate Industries"
- ber  | Berkeley     | technical mono     | font="Berkeley Mono"| sample="Gate Industries"

@scale id=tone steps=5
? Then set the dials
% formal | Formal | Playful | 2
% dense  | Dense  | Airy    | 3
% quiet  | Quiet  | Loud    | 3
% warm   | Cool   | Warm    | 3
```
````

Four blocks in one turn is the **absolute maximum**, and it only works here because
they are one coherent act ("describe the look") and each takes under five seconds.
Do not do this with four unrelated questions -- that is a form, and MIL is not a
form (§1).

```xml
<input block="mood" kind="gallery" values="br,tr" labels="Brutal,Terminal">
Brutal and Terminal.
</input>
<input block="palette" kind="gallery" value="volt" label="Volt"
       swatch="#0a0a0a,#e6ff00,#8a8a8a">
Volt.
</input>
<input block="typeface" kind="gallery" value="ber" label="Berkeley"
       font="Berkeley Mono">
Berkeley Mono.
</input>
<input block="tone" kind="scale" steps="5">
  <dial name="formal" value="2" norm="0.25" poles="Formal|Playful"/>
  <dial name="dense"  value="1" norm="0.00" poles="Dense|Airy"/>
  <dial name="quiet"  value="5" norm="1.00" poles="Quiet|Loud"/>
  <dial name="warm"   value="1" norm="0.00" poles="Cool|Warm"/>
</input>
```

### Turn 4 -- what already exists

> **MOLLY:** Black, acid yellow, monospace, dense and loud. Noted, and I am into it.
> Now show me what you already have so I do not redraw things that exist.

````markdown
```mil
@upload id=assets accept="pdf,png,svg,ai,zip,fig" max=50mb multiple
? Everything you already have
: Logo files, an old brand guide, screenshots, a Figma export. Ugly is fine --
: I would rather see the real mess than a tidied version of it.

@note tone=warn
> This lands in the project transcript permanently. Nothing with credentials in it.

@link id=refs multiple optional submit="These are the ones"
? And anything out there you want this to feel like
: Competitors, sites you love, sites you hate. Hate is more useful.
```
````

```xml
<input block="assets" kind="upload" count="3">
  <file name="gate-brandbook-2019.pdf" mime="application/pdf" size="8451920"
        pages="62" ref="blob_7f3ac91"/>
  <file name="logo-lockup.svg" mime="image/svg+xml" size="14204" ref="blob_c02de5"/>
  <file name="old-dashboard.png" mime="image/png" size="1204830"
        dims="2880x1620" ref="blob_91bb04"/>
The 2019 brand book, the logo, and a screenshot of the dashboard we are replacing.
</input>
<input block="refs" kind="link" count="2">
  <url href="https://linear.app" fetched="yes"
       title="Linear -- A better way to build products"
       desc="Linear streamlines issues, projects and roadmaps."/>
  <url href="https://teenage.engineering" fetched="yes"
       title="Teenage Engineering" desc="We make things that make things."/>
These two.
</input>
```

The PDF and the PNG are attached to that turn as real parts. Molly reads page 12
of the brand book and the screenshot in the same breath as the tag. **This is the
step that makes onboarding worth automating** -- everything before it is a form,
this is where an agent starts doing something a form cannot.

### Turn 5 -- the tension, out loud

> **MOLLY:** Two things before I write this up.
>
> Your 2019 book says "approachable, warm, human". You just picked black, acid
> yellow and a monospace, and pushed Warm all the way to Cool. Those are different
> companies. Which one is true now?

````markdown
```mil
@choice id=brand-truth
? Which one is true?
- new   | The new direction  | the 2019 book is dead, we rebrand
- old   | The 2019 book      | I got carried away with the swatches
- both  | Both, layered      | warm voice, hard surfaces
- dunno | Genuinely unsure   | make the case both ways and I will pick
```
````

> And the second thing: enormous, yesterday, careful money. Pick which one gives.

````markdown
```mil
@order id=tradeoff
? Drag these into the order you would actually defend in a board meeting
- scope | All of the scope
- date  | The date
- cost  | The budget
- craft | The quality bar
```
````

This is the shape to aim for. Molly is **not** filling in fields. She read four
answers, found a contradiction, and asked a question no form could have contained.
The widgets are just how the answer comes back fast.

```xml
<input block="brand-truth" kind="choice" value="both" label="Both, layered">
Both, layered -- warm voice, hard surfaces.
</input>
<input block="tradeoff" kind="order" values="craft,date,scope,cost">
Craft, then the date, then scope, then cost.
</input>
```

### Turn 6 -- the brief, and the one confirm

> **MOLLY:** Here is the brief. Read it properly, this is the thing everything
> else gets measured against.
>
> [prose brief]

````markdown
```mil
@choice id=brief-signoff danger phrase="signed"
? Does this brief describe the job?
: Signing this opens the project and puts it in the build queue. Changing it
: later costs a change order, so read it twice.
- yes  | Yes, that is the job
- edit | Close, but I want changes first
- no   | No, we are further apart than I thought
```
````

Note the shape: the *only* `danger` block in the whole interview is the one with a
consequence. If everything is loud, nothing is.

```xml
<input block="brief-signoff" kind="choice" value="edit" label="Close, but changes first">
Close, but I want changes first.
</input>
```

### Interview design rules that fall out of this

1. **Never more than one turn ahead.** Ask, read, react, then ask. An interview
   that emits all eight blocks at once is a form with extra steps.
2. **Cheap things in bulk, expensive things alone.** Four gallery picks in one
   turn is fine, because each costs a glance. One upload block per turn, because
   it costs the human real effort.
3. **React to what came back before asking the next thing.** Turn 3 opens with
   "big, fast and cheap is two out of three". That single sentence is what makes
   it an interview.
4. **Contradictions are the deliverable.** Turn 5 is worth the other five turns
   combined. Hunt for them.
5. **One `danger` per interview, at the end, on the thing with a consequence.**
6. **Make every block skippable in practice.** Someone will type prose instead of
   clicking. `@void` the block, absorb the prose, carry on without sulking.
7. **Uploads late, never first.** Nobody digs through Dropbox for a robot they
   have exchanged two sentences with.

---

## 8. React

### 8.1 Tree

```
   <MilProvider transport resolutions uploader>
     └── <Mil source={fenceText} messageId={id} />
            │   parseMil(source) -> MilDoc
            │
            ├── <MilShell>  ── frame, title, state badge, receipt footer
            │     ├── <MilChoice/>  <MilGallery/>  <MilInput/>
            │     ├── <MilUpload/>  <MilLink/>     <MilScale/>  <MilOrder/>
            │     ├── <MilExample/>                      (useMilFill)
            │     └── <MilNote/>                         (pure, no hook)
            │
            └── <MilRaw/>   ── escape hatch: unparseable input, shown verbatim
```

### 8.2 Files

```
   mil/
     types.ts          MilDoc, MilNode, MilState, MilAnswer, MilPayload
     parse.ts          parseMil(src): MilDoc          -- pure, total, zero deps
     serialize.ts      toInputTag(node, payload): string   -- the ONLY tag writer
     registry.ts       Record<MilKind, ComponentType<MilBlockProps>>
     Mil.tsx           entry point
     MilProvider.tsx   transport + resolutions + uploader context
     useMilBlock.ts    state machine, idempotent submit, rollback
     useMilFill.ts     example -> target wiring, one message's scope
     useUpload.ts      blob upload, progress, per-file retry
     Shell.tsx         chrome
     blocks/
       Choice.tsx  Gallery.tsx  Input.tsx  Upload.tsx
       Link.tsx    Scale.tsx    Order.tsx  Note.tsx  Example.tsx  Raw.tsx
```

`serialize.ts` is the single writer of `<input>` tags. One function, one escaping
policy, one place to fix it when a client pastes a `"` into a label. Every block
that hand-rolls a tag is a future escaping bug.

Suggested discipline: any file crossing ~150 lines gets split that same sitting.
`Gallery.tsx` and `Upload.tsx` are the two that will try to grow.

### 8.3 The one props contract

Every block component receives the identical shape. This is the extension point:
a new block is a parser case plus a registry entry, and touches nothing else.

```ts
interface MilBlockProps<N extends MilNode = MilNode> {
  node: N                                  // parsed, immutable
  state: MilState                          // open|pending|locked|expired|void
  answer?: MilAnswer                       // present iff state === 'locked'
  disabled: boolean                        // state !== 'open' || resolutions unloaded
  onSubmit(payload: MilPayload): void      // idempotent, safe to call twice
  error?: string                           // last failed submit, cleared on retry
}
```

Dispatch through a map, never a switch chain:

```ts
export const BLOCKS: Record<MilKind, ComponentType<MilBlockProps>> = {
  choice: MilChoice, gallery: MilGallery, input: MilInput, upload: MilUpload,
  link: MilLink, scale: MilScale, order: MilOrder,
  note: MilNote, example: MilExample,
}
const Block = BLOCKS[node.kind] ?? MilRaw
```

### 8.4 The parser contract -- this is agent-authored content

`parseMil` is **total**. It has no throw path. An LLM will eventually emit a
half-finished fence mid-stream, and a thrown parse error inside a transcript
renderer is a white screen for the entire conversation.

| Malformed input | Behaviour |
|---|---|
| unknown `@kind` | render as `@note tone=warn` naming the kind, keep raw text |
| unknown leading sigil | treat as prose, append to the current prompt |
| line before any `@` | implicit `@note` |
| duplicate `id` in one doc | second becomes `id~2`, warn strip |
| missing `id` | derive: `blake3(messageId + kind + normalisedBody)`, first 8 hex |
| unclosed `~~~` | close it at end of fence |
| unclosed fence (streaming) | render what parsed, mark doc `partial`, **suppress all interaction** |
| `@gallery` row with no `img=` | fall back to `render=card` for that row only |
| `> 12` options | render all of them plus a warn strip. Never truncate. |
| `min > max` | clamp, warn |

The derived-id rule matters more than it looks: it must be stable across
re-renders and reloads, so it can only depend on content, never on array position
in a list that streaming might reorder.

**Streaming:** while the assistant message is still arriving, every block renders
inert. A block that becomes clickable before its last option has streamed in is
how someone answers a question they have not finished reading.

### 8.5 The hook

```ts
const { state, answer, submit, error } = useMilBlock(node, messageId)
```

All of its responsibilities:

- resolve initial state from the provider's resolutions map, never from local state,
- hold one nonce per block instance so retries are idempotent,
- optimistic `pending`, rollback to `open` with `error` on nak or timeout,
- refuse to call `onSubmit` at all when `state !== 'open'`,
- subscribe to lock/expire/void for its own id.

---

## 9. Rendering and interaction rules

Each of these has cost someone a bug.

1. **Never autofocus.** Ever. The composer owns the caret. An inline block that
   grabs focus eats the sentence the human was typing.
2. **Height must not change on lock.** Reserve the space. A block shrinking three
   screens up yanks the scroll position out from under the reader.
3. **No layout animation.** Opacity and colour only, and drop even those under
   `prefers-reduced-motion`.
4. **Reserve image space before load.** A gallery that pops in at natural height
   reflows the whole transcript. Fixed aspect box, skeleton, then the image.
5. **Number keys 1-9** select when the block has focus. `Enter` submits multi-select
   and `@input`. Arrows drive `@scale`. `Escape` does nothing -- there is nothing to
   dismiss and people press it reflexively.
6. **Real `<button>` elements.** `select=one` is a `role="radiogroup"`, `select=many`
   is a `<fieldset>` of checkboxes, `@order` has up/down buttons alongside the drag.
7. **Locked leaves the tab order** but stays readable: `aria-label="answered:
   Editorial, Brutal"` on the group, `aria-disabled` on the rows.
8. **Full width of the bubble, not the viewport.** MIL is part of a message.
9. **Mobile:** 44px minimum hit targets, hints wrap under the label rather than
   truncating, gallery goes two-up, the whole `@scale` row is the drag area, and
   `@upload` offers the camera.
10. **Drag-and-drop is never the only path.** `@upload` always has a browse button;
    `@order` always has arrow buttons.

---

## 10. Authoring rules -- for you, Molly

**Do**

- Put the block where the question naturally falls in your sentence. That is the
  entire point of inline.
- Write labels a human scans in one pass. `Product UI`, not `Option B`.
- Use the hint column for the *consequence*, not a restatement.
  `accounts, state, real users` earns its pixels; `the product option` does not.
- Reach for `@gallery` the moment the answer is aesthetic. Six images beat six
  adjectives, every time.
- Reach for `@scale` when the answer is a dial, not a pick. "How formal" is never
  a multiple-choice question.
- Use `@upload` and `@link` early enough to be useful and late enough to be earned.
- Use `@example` whenever a field has a non-obvious shape. One example beats a
  paragraph explaining the shape.
- Set `expires` on anything time-sensitive; `@void` anything the conversation
  overtook.
- Give reversible choices an exit row (`Not sure yet`, `Skip`). A two-option block
  with no exit is a trap, and people click it to make it go away.

**Do not**

- Do not use a block for something you could infer and state. A widget for a
  question you already know the answer to is friction dressed as courtesy.
- Do not exceed about six options, or eight gallery cards. More than that means
  the real answer is an `@input`.
- Do not put a `danger` block mid-paragraph. Give it its own line and its own beat.
- Do not emit a wall of unrelated blocks. Four is the ceiling, and only when they
  are one coherent act.
- Do not assume an answer will come. Every block needs a survivable
  never-answered continuation.
- Do not reference a block's answer in text you write *before* the answer exists.
- Do not write `<input>` tags yourself. That channel belongs to the client.

---

## 11. Failure modes, ranked by how much they will hurt

| # | Failure | Symptom | Guard |
|---|---|---|---|
| 1 | Parser throws on a partial stream | whole transcript white-screens | `parseMil` is total (§8.4) + error boundary per message |
| 2 | Lock derived from client state | reload resurrects an answered block | law II, resolutions from the server (§6.6) |
| 3 | No idempotency key | double-click books two projects | `(blockId, nonce)`, first wins, `409` for the rest (§6.3) |
| 4 | Upload tag emitted before bytes land | Molly gets a `ref` that 404s | lock on submit, not on drop (§6.4) |
| 5 | Uploaded PDF not attached to the turn | Molly cannot read what she asked for | attach real parts, not just a filename (§4.4) |
| 6 | Block autofocuses | the user's typing lands in a text field | §9.1, no exceptions |
| 7 | Height changes on lock, or images pop in | scroll jumps mid-read | §9.2, §9.4 |
| 8 | Unstable derived ids | lock lands on the wrong block after re-render | hash content, never index (§8.4) |
| 9 | Secret echoed into the tag | credential in a permanent transcript | §6.7, mask server-side |
| 10 | Stale blocks left live | user answers a question from twenty minutes ago | `expires` + `@void` (§4.10) |
| 11 | Answer also posted as a chat bubble | question and answer drift apart in the log | §5.3, render as the lock only |
| 12 | Example still clickable after target locks | "Use this" silently does nothing | §4.9, examples die with their target |
| 13 | Fonts unloaded when a `type` gallery paints | human judges Helvetica three times | skeleton until `document.fonts.ready` (§4.2) |
| 14 | Tags hand-rolled per block | one label with a quote in it breaks parsing | one `serialize.ts` (§8.2) |

---

## 12. Reference card

```
   ┌── ASK BLOCKS ────────────────────────────────────────────────────────┐
   │ @choice   text options            @upload  files, real attachments   │
   │ @gallery  image|swatch|type|card  @link    paste URL + fetched card  │
   │ @input    typed fields            @scale   sliders between poles     │
   │                                   @order   drag to rank              │
   │ common:  id= select=one|many min= max= submit= expires= optional     │
   │          danger phrase=                                              │
   ├── SHOW / CONTROL ────────────────────────────────────────────────────┤
   │ @note tone=info|warn|danger   @example for=<id>   @void id= reason=  │
   ├── LINES ─────────────────────────────────────────────────────────────┤
   │ ? prompt          : subtext          # comment (never rendered)      │
   │ - value | Label | hint | img= swatch= font= sample=                  │
   │ _ name[*] | type | Label | placeholder                               │
   │ % name | leftPole | rightPole | default                              │
   │ = field=value     > prose            ~~~lang … ~~~   literal         │
   ├── FIELD TYPES ───────────────────────────────────────────────────────┤
   │ text  longtext  number  bool  secret  path  url  date                │
   ├── ANSWER ────────────────────────────────────────────────────────────┤
   │ <input block="…" kind="…" value(s)= label(s)= [at= by=]>             │
   │   <field name=…>  <file name= mime= size= ref=>  <url href= title=>  │
   │   <dial name= value= norm= poles=>                                   │
   │   A sentence a human would have typed.                               │
   │ </input>                                                             │
   │ attributes are the TRUTH · the sentence is the COURTESY              │
   ├── STATES ────────────────────────────────────────────────────────────┤
   │ open → pending → locked         open → expired         open → void   │
   │ locked, expired and void are absorbing. Nothing leaves them.         │
   └──────────────────────────────────────────────────────────────────────┘
```

---

## 13. Build order

Each step is independently useful. Ship them in this sequence.

1. `types.ts` + `parse.ts` + a fixture suite. **Fuzz the parser** with truncated
   and garbled fences until you cannot make it throw. Load-bearing step.
2. `serialize.ts` + its round-trip tests. Get the escaping right once, at the start.
3. `Shell.tsx` + `Note.tsx` + `Raw.tsx`. You can now render a fence safely with
   zero interaction. Ship that.
4. `MilProvider` + `useMilBlock` + `Choice.tsx` at `select=one`, with the server
   lock. This is the whole product; everything after is coverage.
5. `Gallery.tsx` (image, then swatch, then type), `Input.tsx`, `select=many`.
6. `Upload.tsx` + `useUpload.ts` + the attachment path into the model turn. This
   is the biggest single step -- budget for it.
7. `Link.tsx` with server-side OG fetch, `Scale.tsx`, `Order.tsx`.
8. `Example.tsx`, `danger` + `phrase`, `expires`, `@void`.

### Acceptance -- the tests worth writing

- Double-click a choice on a throttled connection: exactly one answer is honoured,
  the UI settles on the winner, no error is shown.
- Answer in tab A; tab B goes locked without a refresh.
- Reload a page full of answered blocks: no block is ever momentarily clickable.
- Truncate a fence at every byte offset and render each prefix: no throw, no
  interactive control, ever.
- A locked block occupies precisely the same pixel height as it did open.
- Type into the composer while a block streams in above: not one keystroke lost.
- Upload three files, kill the network during the second: the block stays open,
  that row shows failed with a retry, and no tag is emitted.
- A 48-page PDF uploaded through `@upload` is readable by the model in the same
  turn as its `<input>` tag.
- A label containing `"` and `|` and `<` survives the round trip through
  `serialize.ts` and back.
- A `secret` field's value appears nowhere in the transcript, the receipt, or the
  tag.

---

```
      ╭──────────────────────────────────────────────────────────────╮
      │   ┌───────┐                                                  │
      │   │ ◉   ◉ │    Rich going down. Structured text coming up.   │
      │   │   ‿   │    Ask it inline. Ask it once.                   │
      │   └──┬─┬──┘    The click is the signature.                   │
      │      ╰─╯                                                     │
      │                -- MIL v1, for MOLLY @ GATE                   │
      ╰──────────────────────────────────────────────────────────────╯
```
