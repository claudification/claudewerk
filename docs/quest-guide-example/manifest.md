---
petname: brass-otter
project: claude://sentinel/Users/jonas/projects/remote-claude
goal: Ship a `--version` flag on broker-cli that prints the package version.
target: merged
status: armed
gate:
  verdict: blessed
  blessed_by: jonas
  blessed_at: 2026-07-05T05:41:49Z
tasks:
  - id: t1
    title: Add --version flag to broker-cli
    accept: "cd \"$WORKTREE\" && bun test src/broker/cli/version.test.ts && bun run src/broker/cli.ts --version | grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+'"
    accept_note: >
      Unit test covers arg parsing in parse-args.ts; the grep runs the real CLI
      entrypoint and proves it prints a semver line (package.json version) to stdout.
    kind: build
constraints:
  - Touch only src/broker/cli/ and its tests.
  - No new dependencies (read the version from the bundled package.json).
deny_floor:
  - Bash(git push:*)
created: 2026-07-05T05:40:00Z
updated: 2026-07-05T05:41:49Z
---

## Why now

`broker-cli` (`src/broker/cli.ts`) has no way to report its own version. Ops
can't tell which build a container is running without `docker inspect` on the
image. A `--version` flag closes that gap with a one-line answer.

## Notes

- Version source is the `version` field in the `package.json` already bundled
  into the CLI (currently `0.1.0`). No network, no new dep.
- Flag parsing lives in `src/broker/cli/parse-args.ts`; add `--version` there and
  short-circuit before the subcommand dispatch in `cli.ts`.
- Single build leg, `target: merged` — it should land on main once green.
