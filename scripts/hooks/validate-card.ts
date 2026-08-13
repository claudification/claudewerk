#!/usr/bin/env bun
/**
 * PostToolUse card validator -- IN-REPO entry point.
 *
 * On a real claudewerk machine there is no source checkout, so the shipped hook
 * is the agent host's own flag and needs nothing else installed:
 *
 *   "PostToolUse": [{
 *     "matcher": "Write|Edit|MultiEdit",
 *     "hooks": [{ "type": "command", "command": "rclaude --rclaude-validate-card" }]
 *   }]
 *
 * This script exists only for THIS repo, where the source is newer than whatever
 * `rclaude` binary happens to be installed (the installed one is a frozen
 * bundle). Same module, same behaviour -- it is an entry point, not a copy.
 */

import { readHookStdin, runCardWriteHook } from '../../src/shared/project-card-hook-run'

const { exitCode, stderr } = runCardWriteHook(readHookStdin())
for (const line of stderr) console.error(line)
process.exit(exitCode)
