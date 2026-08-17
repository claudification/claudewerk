# ANVIL -- pointer

**The ANVIL specification does not live in this repository.** It moved to its own
project on 2026-08-18.

| | |
|---|---|
| **Spec** | `~/projects/anvil-md/SPEC.md` |
| **Repo** | `github.com/anvil-md/anvil` (private) |
| **Site** | <https://anvil-md.frst.dev/> -- overview, the spec as a browsable document, and a client-side playground |
| **Board** | `~/projects/anvil-md/.rclaude/project/` |

Do not re-add a copy of the spec here. There was one, it was 900 lines, and
keeping it in step with the real one was never going to happen.

---

## What ANVIL is, in three lines

A tiny line-oriented DSL an agent writes inside a fenced code block, mid-sentence.
The host renders that fence as **real UI inline in the conversation** instead of
as a code block. A human answers it once, the block freezes, and the answer
arrives back as a structured `<stamp>` text tag the model reads as an ordinary
turn.

Markdown going down, structured text coming up, and nothing in between.

---

## What is in THIS repository

`web/src/components/anvil/` -- a **render-only** implementation, wired into
`web/src/components/markdown.tsx` so an ` ```anvil ` fence in a transcript
renders as UI rather than as a code block.

Five block kinds (`@choice`, `@gallery`, `@input`, `@scale`, `@note`), inline SVG
icons, and the streaming guard that keeps a block inert until its fence closes.
**Every control carries `disabled`** -- this draws a block, it does not run one.

Two things to know before touching it:

1. **It is a fork by copy** of `anvil-md/packages/{parser,render-html}`, taken on
   2026-08-14, and the two have already diverged. Retiring the fork is tracked on
   [anvil-adopt-in-claudewerk](../.rclaude/project/cards/anvil-adopt-in-claudewerk.md).
2. **The parser is total by contract.** It has no throw path, because an LLM
   emits a fence token by token and a throw inside the transcript renderer takes
   down the whole conversation, not one block. If you change it, keep the fuzz
   test that walks every prefix of every fixture.

## Why it matters here specifically

Verified at `src/agent-host-common/mcp-host/mcp-tools/dialog.ts:219`: **one-shot
`dialog` does not block either.** It returns immediately and its answer arrives
as a channel message -- exactly like a stamp. So one-shot dialog and ANVIL are
semantically the same thing, and ANVIL costs four lines of markdown instead of an
MCP round trip, rendered where the question was asked.

The **live/persistent** dialog is genuinely different -- patch grammar,
compare-and-swap `setState`, tabs, redraw-in-place -- and ANVIL's founding axiom
forbids all of that on purpose. That tool stays.
