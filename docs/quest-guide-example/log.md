# Quest Log

Append-only intent/completion/plan/steering entries (never rewritten).

### 2026-07-05T05:41:49Z intent [conv_intake_brass_otter]

Quest blessed at intake by jonas. Target `merged`, one build contract (t1: add `--version` to broker-cli). Acceptance = unit test on parse-args + a real-CLI grep for a semver line. Constraints (touch only src/broker/cli/, no new deps) recorded here since the v1 schema has no constraints field. Next: dispatch t1 in a fresh worktree off main.

