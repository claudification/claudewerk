# Dry-run intake transcript — `brass-otter`

A worked run of the `quest-intake` skill against a toy goal, showing the
five-stage flow and how it produced [`manifest.md`](./manifest.md) +
[`log.md`](./log.md). This IS the skill's acceptance test: a fresh Opus with only
`docs/quest-guide.md` + the skill should be able to reproduce this shape.

**Toy goal:** "add a `--version` flag to broker-cli."

> Fixture provenance: `manifest.md` and `log.md` in this folder were generated
> **by the real store** (`createQuest` + `appendLogEntry` in
> `src/shared/quest-store.ts`) — the exact code the `create_quest` /
> `quest_log_append` MCP verbs call. So the on-disk shape here is byte-for-byte
> what the engine writes, not a hand-drawn mock.

---

### Stage 0 — open the live dialog

Interviewer opens a persistent dialog titled "Quest intake — broker version
flag", `width: wide`, four tabs (`Goal`, `Tasks`, `Target`, `Draft`),
`submitLabel: "Send to agent"`, `finalizeLabel: "Bless it — create the quest"`.
The `Draft` tab starts nearly empty (a stub manifest block) and fills in as the
interview proceeds. `dialogId` saved.

### Stage 1 — goal + why-now

**Interviewer:** One sentence: what does "done" mean, and why now?
**Quest Giver:** broker-cli can't report its own version; ops can't tell which
build a container runs without `docker inspect`. Want `broker-cli --version` to
print the version.
**Interviewer:** Which repo? → `remote-claude`. Working name → "broker version
flag". *(Patches `Draft`: `## Goal` + `project` fill in; focuses `Draft` tab.)*

### Stage 2 — decompose into tasks

**Interviewer:** This is small — one leg. Read the version from the bundled
`package.json`, add the flag in `parse-args.ts`, short-circuit in `cli.ts`. Agree
it's a single build task, no Scout needed?
**Quest Giver:** Yes, one task.
*(Patches `Draft`: one acceptance contract `t1` takes shape; its board card will
carry the leg title "Add --version flag to broker-cli".)*

### Stage 3 — acceptance command (THE GATE)

**Interviewer:** What command proves it's done? "the flag is added" isn't
checkable — I need an exit-0-iff-done command.
**Quest Giver:** Just check it prints the version.
**Interviewer:** Good, but let's make it real. Two parts: a unit test on the arg
parser, and a grep that runs the actual CLI and confirms a semver line:
```
cd "$WORKTREE" && bun test src/broker/cli/version.test.ts \
  && bun run src/broker/cli.ts --version | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+'
```
Exits 0 only if the parser test passes AND the real binary prints a semver line.
**Quest Giver:** Ship it.
*(Patches `Draft`: contract `t1.command` + `t1.description` fill in — this is the
`## Acceptance` JSON fence.)*

### Stage 4 — target + constraints

**Interviewer:** Target? `pr | merged | shipped`. This should land on main →
recommend `merged` (default). Any constraints?
**Quest Giver:** `merged`. Don't add dependencies; touch only the CLI.
**Interviewer:** Noted — the v1 schema has no `constraints`/`deny_floor` field
yet (guide §6), so I'll record "touch only src/broker/cli/, no new deps, no
self-push" in the blessing log entry and the contract `description` rather than a
manifest field. Because target is `merged`, not `shipped`, no human checkpoint is
forced (§7c) — the integrator handles the ff-merge.
*(Patches `Draft`: `target` fills in.)*

### Stage 5 — final review + bless

**Interviewer:** *(focuses `Draft` tab; full manifest shown)* Here's the
complete quest — one build leg, machine-checkable acceptance, `merged` target.
Read it back… good?
**Quest Giver:** *(hits "Bless it — create the quest" → `_final: true`)*

### On blessing — write via the verbs

`create_quest` is available → **primary path**:
1. `create_quest` generates the petname `brass-otter` (collision-checked under
   `.rclaude/project/quests/`), writes `manifest.md` (`gate: blessed`,
   `status: armed`) + the `## Acceptance` contract, and creates `artifacts/`.
2. `quest_log_append` writes the initial `intent` entry — quest blessed by jonas,
   target, contract count, the recorded constraints, what dispatches next.
   (Separate verb so the log can NEVER be rewritten via a manifest patch.)
3. Interviewer reports the petname `brass-otter` back to the Quest Giver and
   closes the dialog.

*(Fallback: on a host where `create_quest` is not in the tool list, the skill
writes the same files directly and flags it loudly — see the skill's Fallback
section. This fixture used the primary verb path.)*

---

## What this fixture demonstrates

- The gate held: the vague "check it prints the version" was pushed into a real,
  exit-code-checkable command before blessing (§3).
- One task = one leg, correctly sized (§5) — no over-decomposition.
- Target ladder applied with its default (`merged`) and the §7c checkpoint
  reasoning made explicit.
- The **real serialized shape**: scalars in frontmatter, `goal` under `## Goal`,
  contracts under a `## Acceptance` JSON fence, log entries as
  `### <ts> <kind> [<convId>]` — reconciled to the merged v1 schema.
- Fields the interview discussed but the v1 schema doesn't persist (constraints,
  deny-floor) landed in the log, not invented manifest keys (guide §6).
