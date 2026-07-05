# Quest log — brass-otter (append-only)

> Never rewrite an entry. Only append. Written by `quest_log_append` (or the
> intake fallback for the first entry).

### 2026-07-05T05:41:49Z · intent · conv_intake_brass_otter
Quest blessed at intake. Target `merged`, one build leg (t1: add `--version` to
broker-cli). Acceptance = unit test on parse-args + a real-CLI grep for a semver
line. Constraints: touch only `src/broker/cli/`, no new deps. Next: dispatch t1
in a fresh worktree off main.
