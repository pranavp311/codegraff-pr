# AGENTS.md

`feat/ios-companion-app` is a **downstream** branch: the iOS companion app
(`apps/ios/`) plus the `src/main.zig` streaming-read stall-watchdog fixes, built
on top of the harness / GUI / SDK work that lands on the other branches.

## Before working here, `git pull` from the other branches

Always sync this branch first, so the app builds against the latest harness and
`graff serve`:

```bash
git fetch origin
git pull origin release/0.0.16   # active release line (harness, GUI, SDK)
git pull origin main             # mainline
```

- On conflicts in **shared** files (`src/main.zig`, `gui/`, `sdk/`, `build.zig`),
  take the other branch's version — this branch only *owns* `apps/ios/**`.
- The app speaks the `graff serve` NDJSON protocol
  (`apps/ios/Graff/Sources/GraffServeClient.swift`); pull in any serve / event-
  protocol changes from `release/0.0.16` **before** touching the app transport.

This branch is meant to follow the others, not diverge them.
