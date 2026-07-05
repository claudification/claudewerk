# Dry-run intake transcript — `brass-otter`

A worked run of the `quest-intake` skill against a toy goal, showing the
five-stage flow and how it produced [`manifest.md`](./manifest.md) +
[`log.md`](./log.md). This IS the skill's acceptance test: a fresh Opus with only
`docs/quest-guide.md` + the skill should be able to reproduce this shape.

**Toy goal:** "add a `--version` flag to broker-cli."

> Note on this fixture: `create_quest` did not exist anywhere at authoring time
> (H2 unmerged), so this run took the **direct-write fallback** and wrote the
> manifest folder itself. That is flagged in the final step, exactly as the skill
> instructs.

---

### Stage 0 — open the live dialog

Interviewer opens a persistent dialog titled "Quest intake — broker version
flag", `width: wide`, four tabs (`Goal`, `Tasks`, `Target`, `Draft`),
`submitLabel: "Send to agent"`, `finalizeLabel: "Bless it — create the quest"`.
The `Draft` tab starts nearly empty (a stub YAML block) and fills in as the
interview proceeds. `dialogId` saved.

### Stage 1 — goal + why-now

**Interviewer:** One sentence: what does "done" mean, and why now?
**Quest Giver:** broker-cli can't report its own version; ops can't tell which
build a container runs without `docker inspect`. Want `broker-cli --version` to
print the version.
**Interviewer:** Which repo? → `remote-claude`. Working name → "broker version
flag". *(Patches `Draft`: `goal`, `project` fill in; focuses `Draft` tab.)*

### Stage 2 — decompose into tasks

**Interviewer:** This is small — one leg. Read the version from the bundled
`package.json`, add the flag in `parse-args.ts`, short-circuit in `cli.ts`. Agree
it's a single build task, no Scout needed?
**Quest Giver:** Yes, one task.
*(Patches `Draft`: `tasks[0].title = "Add --version flag to broker-cli"`,
`kind: build`.)*

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
*(Patches `Draft`: `tasks[0].accept` + `accept_note` fill in.)*

### Stage 4 — target + constraints

**Interviewer:** Target? `pr | merged | shipped`. This should land on main →
recommend `merged` (default). Any constraints?
**Quest Giver:** `merged`. Don't add dependencies; touch only the CLI.
**Interviewer:** Adding `deny_floor: Bash(git push:*)` so the unattended leg
can't push on its own. Because target is `merged`, not `shipped`, no human
checkpoint is forced (§7c) — the integrator handles the ff-merge.
*(Patches `Draft`: `target`, `constraints`, `deny_floor` fill in.)*

### Stage 5 — final review + bless

**Interviewer:** *(focuses `Draft` tab; full manifest shown as YAML)* Here's the
complete quest — one build leg, machine-checkable acceptance, `merged` target.
Read it back… good?
**Quest Giver:** *(hits "Bless it — create the quest" → `_final: true`)*

### On blessing — write

`create_quest` not available → **direct-write fallback**:
1. Petname generated: `brass-otter` (no collision under `.rclaude/project/quests/`).
2. Wrote `manifest.md` (blessed frontmatter + body).
3. Wrote `log.md` with the initial `intent` entry.
4. Created `artifacts/`.
5. **Flagged:** "create_quest wasn't available, so I wrote the manifest directly
   to `.rclaude/project/quests/brass-otter/`. Reconcile via the verbs once H2
   lands." Dialog closed.

---

## What this fixture demonstrates

- The gate held: the vague "check it prints the version" was pushed into a real,
  exit-code-checkable command before blessing (§3).
- One task = one leg, correctly sized (§5) — no over-decomposition.
- Target ladder applied with its default (`merged`) and the §7c checkpoint
  reasoning made explicit.
- The fallback path fired and was flagged, proving the skill degrades correctly
  while the §4e verbs are unmerged.
