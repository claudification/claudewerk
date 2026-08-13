# Conversation addressing

**One way to name a conversation:** `project:conversation`.

```
remote-claude:nightshift
arr:movie-sync
remote-claude:fix-login-a1b2c3     <- disambiguated sibling
```

This is not new. It is what `send_message` and the MCP `list_conversations`
have always spoken (`computeLocalId`). It was simply never written down, so
other surfaces grew their own handles alongside it. This document is the
convention; `src/shared/conversation-address.ts` is the implementation, and
there should be exactly one.

## The three handles, and which is which

| Handle | Example | Who uses it | Stable? |
|---|---|---|---|
| **Address** | `remote-claude:nightshift` | Humans, subscriptions, `send_message` `to` | Follows renames (with an alias window) |
| **Conversation id** | `conv_8f3a…` | `read_transcript`, `read_events`, storage, the wire | Forever |
| **Project URI** | `claude://default/Users/…/remote-claude` | Identity, permissions, spawn | Forever |

The address is for **naming**; the id is for **reading**. A desk row carries
both (`address` and `id`) precisely so neither has to be guessed from the other.
The project URI is the identity — the address's project half is *derived* from
it and is not a substitute for it.

## How an address is built

- **Project half** — the stored project label, else the URI's last path segment,
  run through `slugifyAddressPart` (lowercase, non-alphanumerics to hyphens,
  24 chars). So `/srv/my_site.com` addresses as `my-site-com`.
- **Conversation half** — the conversation title (else the first 8 chars of its
  id), same slugging. If a **sibling in the same project** would slug to the
  same value, both get a `-<6 char id>` suffix. Collisions are resolved within a
  project only: `remote-claude:fix` and `arr:fix` coexist untouched.

Renaming a conversation retires its old slug into `formerSlugs`, which keeps
routing for a decay window (`isAliasLive`), so a peer that cached the old
address does not silently fail.

### Caller-independent vs address-book addresses

`computeLocalId` is normally handed a project slug from the **caller's address
book**, so the same conversation can be `arr:worker` to one peer and
`arr-2:worker` to another. That is correct for routing a reply and useless as a
subscription key. `conversationAddress()` always derives the project half from
the project itself, so every subscriber names the same conversation the same
way. Use it for anything that outlives a single exchange.

## Patterns

The same address plus two globs. Used by `watch_conversations` today; anything
matching a *set* of conversations should use this rather than inventing a
syntax.

| Pattern | Matches |
|---|---|
| `remote-claude:nightshift` | exactly that conversation |
| `remote-claude:*` | every conversation in that project |
| `remote-claude` | same as above — a bare token is a **project** |
| `*:fix-*` | anything named `fix-*` in any project |
| `*` | the entire fleet |

- Only `*` (any run) and `?` (one character) are metacharacters.
- **Regex is refused, not reinterpreted.** `.*`, `^x`, `[a-z]+` all fail to
  parse and come back in `rejected`. A dot is refused outright rather than
  folded to a hyphen, specifically so a model reaching for `.*` out of habit
  cannot silently subscribe to everything.
- Spoken spacing folds: `"Remote Claude"` → `remote-claude:*`.
- Matching is case-insensitive on both sides.

## Where it is enforced

| File | Owns |
|---|---|
| `src/shared/conversation-address.ts` | The convention: slugging, formatting, pattern parse + match |
| `src/broker/conversation-address.ts` | Resolving a live conversation to its address (collision rule) |
| `src/broker/desk/desk-addresses.ts` | Addressing the whole fleet in one pass, for desk rows + match previews |
| `src/broker/handlers/channel-id.ts` | Resolving an inbound `to` (aliases, ambiguity, cross-project fallback) |

`src/broker/address-book.ts` re-exports `slugify` from the shared module — it is
a re-export, not a second definition. Adding a third is a routing bug: an
address minted under different rules resolves to a different conversation, or to
none.

## Known gap

The desk's `list_conversations` now carries `address`, but the browser's spoken
matcher (`web/src/lib/voice-orb/resolve-conversation.ts`) still ranks a spoken
name against live titles with its own fuzzy scoring, refusing on ties. That is
appropriate for speech (which has no punctuation), but it means two matchers
exist. Folding it onto the address convention is unstarted.
