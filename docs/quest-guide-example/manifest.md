---
petname: brass-otter
project: claude://sentinel/Users/jonas/projects/remote-claude
target: merged
status: armed
gate: blessed
created: 2026-07-05T05:40:00.000Z
updated: 2026-07-05T05:40:00.000Z
---

## Goal

Ship a `--version` flag on broker-cli that prints the package version.

## Acceptance

```json
[
  {
    "id": "t1",
    "command": "cd \"$WORKTREE\" && bun test src/broker/cli/version.test.ts && bun run src/broker/cli.ts --version | grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+'",
    "description": "Unit test covers arg parsing in parse-args.ts; the grep runs the real CLI and proves it prints a semver line (package.json version) to stdout."
  }
]
```
