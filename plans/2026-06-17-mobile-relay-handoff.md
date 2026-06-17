# Mobile feature — handoff (2026-06-17)

Pick-up doc for finishing **Codegraff Mobile**: "Claude Code on your phone" — drive a real `graff`
agent running on the user's own machine, from a phone, anywhere. Architecture mirrors Claude Code's
**Remote Control** model: a headless daemon dials *out* to a cloud relay; the phone connects to the
relay; the relay routes phone↔daemon. Inspired by stablyai/orca.

> **Original plan (authoritative, read first):**
> `~/.claude/plans/we-built-a-gui-modular-catmull.md` (lives outside the repo — it's the full
> research + rationale + phasing). This handoff summarizes it and records what's done since. The
> **wire contract** is `relay-dev/PROTOCOL.md` (in-repo, canonical, `protocol_version: 1`).

## Locked decisions (do NOT relitigate)
- Transport: **cloud relay + headless `graff serve --relay` daemon** (outbound-only, no inbound ports).
- Mobile stack: **Expo + React Native** (iOS + Android, one codebase).
- v1 scope: **full steering** — start/resume sessions, stream text/reasoning/tool activity, answer
  `ask_user`, approve/deny permissions, switch model/effort/fast/mode, cancel, push notifications.
- Tenancy: **multi-tenant from day one**, per-account isolation (the one invariant that must never break).
- Auth: **reuse codegraff's existing account + device-auth** (`graff login` device-code flow).
- The relay backend lives in **`justrach/muonry`** (we don't own it) — spec'd via an issue; the owner
  implements. `relay-dev/` is our **reference implementation + executable spec** to develop against now.

## Architecture
```
 Expo app  ──WSS──▶  RELAY (muonry)  ◀──WSS──  graff serve --relay  (user's machine)
  "client"           per-account router        └─ graff --json child per session
                     + Expo push fan-out
```

---

## ✅ DONE (on branch `mobile-relay`)

**Phase 0 — muonry relay spec.** Issue **[justrach/muonry#2](https://github.com/justrach/muonry/issues/2)**
filed and then heavily expanded (worked bidirectional JSON examples, sequence diagrams, acceptance
tests, and a **Blocking Questions** section). Points the owner at our reference relay to port.

**Phase 1 — `graff serve --relay` daemon (complete, tested).**
- `src/relay.zig` — hand-rolled RFC 6455 **WebSocket client** (handshake, client masking, ping/pong,
  close, fragmentation, 1 MiB cap) over **ws:// and wss://** (TLS via `std.crypto.tls.Client`;
  `--relay-insecure` skips verification for self-signed dev relays).
- `src/main.zig` (serve section) — `--relay <url>` + `--relay-insecure` flags; `serveRelayMain` →
  `relayConnectOnce` (hello/welcome, `sessions` presence, reconnect w/ backoff); **concurrent
  channels** (each frame handled on a connection-scoped `Io.Group` worker, WS write mutex) so an
  `answer`/new open runs while a turn streams; `notify` on ask_user/turn. Reuses the existing
  `serveSpawn` / `serveApplyAnswer` with the HTTP path (no logic fork). `schema_relay_json` in
  `--schema` + help text.
- `src/relay_smoke.zig` — standalone `zig run` smoke test (not in the build).

**Phase 3 — reference relay (complete).** `relay-dev/relay.ts` (Bun) implements `PROTOCOL.md` exactly.
Tests (all passing) — these double as the **acceptance suite for muonry's relay**:
- `test-isolation.ts` — cross-account isolation (the must-never-break invariant).
- `test-daemon-e2e.ts` — real daemon ↔ relay ↔ mock client: create/message/delete round-trip.
- `test-tls.ts` — same over `wss://` (self-signed).
- `test-real-turn.ts` — a real model turn streaming daemon→relay→client.

**Bug found & fixed during real-turn validation** (`relay: only forward JSON-object lines`): `graff`
can print plain non-JSON lines to stdout (e.g. `api error: …`); the relay path embedded each raw
child line as frame `data`, producing invalid JSON → the relay dropped the connection mid-turn. Fix:
the daemon skips child stdout lines that aren't JSON objects. HTTP `serve` was unaffected.

---

## 🚧 LEFT TO DO

### A. Blocked on the muonry owner (does NOT block local dev — use `relay-dev/`)
The production relay needs answers to the **Blocking Questions** in muonry#2:
1. **Token → `{account_id, device_id}`** resolution (opaque token + introspection endpoint, or a
   verifiable JWT?). *The #1 blocker for talking to a real relay.*
2. **Phone enrollment** — can the app reuse the `graff login` device-auth flow? `verification_uri_complete`
   for a QR? a `relay` scope?
3. **Relay host** to hardcode as the daemon/app default (e.g. `wss://relay.codegraff.com`).
4. **Push** — relay → Expo Push API directly vs muonry push; who owns Expo/APNs/FCM creds.
5–6. State/scale/persistence + abuse limits (hardening, not first-version blockers).

Until answered: develop the whole app against `relay-dev/` with dev tokens (`"<account>:<device>"`).

### B. Phase 4–6 — the Expo app (NOT STARTED; the bulk of remaining work) → new `mobile/`
Build transport-first and testable, mirroring how the daemon was built.
1. **Scaffold** `mobile/` (Expo + RN, TypeScript).
2. **`RelayHarness`** (`mobile/src/transport/relay.ts`) — relay-transport analogue of
   `sdk/ts/remote.ts`'s `RemoteHarness`. **Reuse the `Event` union from `sdk/ts/remote.ts`.** It
   opens a WSS to `…/v1/relay/client`, does `hello`, tracks `presence`, and per request opens a
   `channel` (`open`/`event`/`end`) yielding demuxed events. Methods: `chat/answer/setModel/
   setEffort/setFast/setMode/compact/cancel/close`. Write a **headless test against `relay-dev`**
   first (same pattern as `relay-dev/test-*.ts`).
3. **Pairing/auth** — device-auth flow (scan QR of `verification_uri_complete` or enter `user_code`)
   → token in `expo-secure-store` (keychain). (Depends on owner Q2; stub with dev tokens until then.)
4. **Session store/reducer** — port the GUI's snapshot/reducer logic from
   `gui/src/app/sessionStore.ts` + `gui/src/hooks/useSession.ts` into a Zustand store fed by the
   relay event stream (build the snapshot client-side from the `event` deltas).
5. **Screens** — pairing → daemon/session list (from `presence`) → chat view (stream
   text/reasoning/tool rows; reuse the *shape* of `gui/src/components/chat/ChatActivityRow|ChatWorkRow`,
   rebuilt in RN) → `ask_user` bottom sheet → permission approve/deny sheet → controls
   (model/effort/fast/mode, cancel) → settings. Reuse design tokens from `gui/src/styles/index.css`.
6. **Push** — `expo-notifications`; register the push token in `hello`; deep-link a push (its `data`
   carries `session_id`/`daemon_id`/`kind`) into the right session.

### C. Phase 7 — hardening (after the app works)
- **Daemon graceful shutdown** — SIGTERM handler to stop the teardown `WriteFailed` log noise.
- **Real `busy` state in presence** (currently always `false` in the daemon's `sessions` frame).
- **E2E encryption** (Orca-style X25519 + secretbox) — additive: only `open.body`/`event.data`
  become ciphertext; routing/`notify` stay plaintext (already designed for; see PROTOCOL §11).
- **Per-session git worktree** spawn (`--spawn worktree`) — v1 is same-dir; needed before promoting
  "parallel agents".
- **Event replay buffer** — v1 resets in-flight streams on reconnect (`transport_reset`); optional.
- **`sdk/ts/relay.ts` generation** — plan wanted a generated relay client (like `remote.ts`). Decide:
  generate from `graff --schema` (add `schema_relay_json` shapes to `sdk/generate.py`) vs hand-port.
- Confirm `set_effort`/`set_fast` pass through `serveMessage` to the child (they aren't in the
  documented `serve` message list; likely forwarded raw — verify + document).

---

## How to run / test locally
```bash
# build the daemon
zig build                       # produces ./zig-out/bin/graff

# terminal 1: reference relay (ws://127.0.0.1:8788)
cd relay-dev && bun relay.ts

# terminal 2: daemon dials the relay (dev token "<account>:<device>")
./zig-out/bin/graff serve --relay ws://127.0.0.1:8788/v1/relay/daemon --token acct1:mac --yolo

# run the suites (each spins up its own relay + daemon)
cd relay-dev
bun test-isolation.ts
bun test-daemon-e2e.ts
NODE_TLS_REJECT_UNAUTHORIZED=0 bun test-tls.ts          # wss:// (needs openssl)
bun test-real-turn.ts                                    # needs a WORKING provider key
```
**Real successful turns need a valid provider key.** At handoff: `OPENAI_API_KEY` was *rejected*
("API key not recognized") and codex (`~/.codex/auth.json`) authenticated but was **rate-limited
(429)**. Run `graff login` (codegraff) or supply a working key, then `test-real-turn.ts` prints the
live reply + cost. The streaming path itself is proven regardless (error events flow through fine).

---

## ⚠️ Repo state / WIP / rebase notes (read before pushing)
- **Branch: `mobile-relay`.** The user **rebased** it locally, so SHAs differ from `origin` and the
  branch shows "ahead/behind" origin. **Do not force-push without the user's OK** — history is shared.
- **A second Claude agent is actively committing GUI bug-fixes to this same branch** (e.g.
  `Fix chat selection and provider credential UX`, `gui: add @codegraff/diffs package …`). Always
  `git pull --rebase` before pushing and coordinate; expect concurrent GUI commits unrelated to relay.
- **WIP:** the `@codegraff/diffs` package + "files changed" panel (commit `4a981d7`) is the user's
  in-progress GUI work — leave it alone.
- `relay-dev/harness.trace.jsonl` / `harness.trajectory.jsonl` are gitignored test artifacts (ignore).
- The relay code survives the GUI merges (build is green); the two workstreams are largely orthogonal
  (relay = `src/relay*.zig` + serve section of `src/main.zig` + `relay-dev/`; GUI = `gui/`).

## Critical files
| Area | Path |
|---|---|
| Wire contract (canonical) | `relay-dev/PROTOCOL.md` |
| Reference relay + tests | `relay-dev/relay.ts`, `relay-dev/test-*.ts` |
| Daemon WS client | `src/relay.zig` |
| Daemon relay mode | `src/main.zig` (`serveRelayMain`/`relayConnectOnce`/`relayOpen`/`relayStreamMessage`, `schema_relay_json`, `--relay` flag) |
| Underlying agent protocol | `sdk/ts/remote.ts` (`Event` union — reuse in the app), `src/main.zig` `serve*` |
| Session UI logic to port | `gui/src/app/sessionStore.ts`, `gui/src/hooks/useSession.ts`, `gui/src/components/chat/*` |
| Design tokens | `gui/src/styles/index.css` |
| Original plan | `~/.claude/plans/we-built-a-gui-modular-catmull.md` |

## Gotchas learned (save yourself the debugging)
- **Only forward JSON-object lines** from the child over the relay (non-JSON diagnostics break frame JSON).
- **`answer` is an ack-only side channel** on its own channel; the original `user` channel keeps
  streaming. The relay must multiplex channels concurrently (don't serialize).
- **Cross-account isolation** must be enforced on *every* forwarded frame — gate with `test-isolation`.
- Concurrent read (relay socket) + write (event frames) on the daemon's WS is fine; writes are
  mutex-serialized, the read loop stays free.
- **No stream replay in v1** — reconnect resets in-flight channels; sessions (children) survive.
- Zig 0.16: `std.ArrayList` init is `.empty`; `Io.Clock.real.now(io)`; TLS needs 4 buffers
  (`min_buffer_len`); ws import is aliased `relayws` (avoids a `winsize` `ws` collision).
