# Codegraff Relay Protocol — v1 (canonical contract)

This is the **single source of truth** for the wire contract between the three parties of the
codegraff mobile feature. The `relay-dev/` reference relay implements it exactly; the muonry
production relay must match it; the `graff serve --relay` daemon and the Expo app are clients of it.

> **Stability promise.** This is `protocol_version: 1`. Changes are **additive only** — new frame
> types and new optional fields. Every party MUST ignore unknown frame types and unknown fields.
> A breaking change bumps `protocol_version` and is negotiated in the handshake. Implement to this
> doc and you will not need to re-implement as the mobile feature grows.

```
 Expo app  ──WSS──▶  Relay (muonry)  ◀──WSS──  graff serve --relay (daemon)
  "client"            account router             "daemon"
                      + push fan-out             + graff --json children
```

The relay is a **content-agnostic, per-account router**. It does not parse the agent protocol;
it forwards opaque `body`/`data` payloads and routes by `account_id`. This keeps optional E2E
encryption (Phase 7) a drop-in: only `body`/`data` become ciphertext; routing fields stay plain.

---

## 1. Transport

- **WSS** (TLS). Two endpoints, distinguished by role: `wss://<relay>/v1/relay/daemon` and
  `wss://<relay>/v1/relay/client`. (Role may instead be carried in the `hello` frame; the relay
  MUST accept either — see §3.)
- Every WS **text** message is exactly **one JSON object** with a string discriminator field `t`
  (the frame type). No NDJSON batching inside a single WS message.
- **Binary** frames are reserved for future E2E; v1 senders MUST NOT send binary.
- **Size limits** (mirror the daemon's existing `serve` caps): a single relayed `event.data`
  may be up to **1 MiB**; a single `open.body` (a user prompt with pasted files) up to **8 MiB**.
  Relays MUST allow WS messages large enough to carry these plus envelope overhead (allow 9 MiB).
- **Encoding:** UTF-8 JSON. Unknown fields preserved/ignored, never rejected.

---

## 2. Frame types (the complete v1 set)

| `t` | Direction | Purpose |
|-----|-----------|---------|
| `hello` | client/daemon → relay | first frame; authenticate + declare role |
| `welcome` | relay → client/daemon | handshake accepted; assigns id + params |
| `presence` | relay → client | snapshot/delta of the account's daemons + sessions |
| `sessions` | daemon → relay | the daemon's current session list (snapshot/delta) |
| `open` | client → relay → daemon | start a request on a channel (create/message/delete) |
| `event` | daemon → relay → client | one `graff --json` event on a channel |
| `end` | daemon → relay → client | channel terminated (complete or error) |
| `notify` | daemon → relay | trigger a push (carries no agent content) |
| `ping` / `pong` | both | heartbeat (WS-level ping/pong MAY be used instead) |
| `error` | relay → either | out-of-band error not tied to a channel |
| `close` | relay → either | relay is closing the connection (with reason) |

---

## 3. Handshake & auth

Both roles authenticate with a **codegraff account/device token** — the same per-device token
`graff login` already issues (device-auth: `/v1/device/start` + `/v1/device/poll`, validated by the
gateway). The relay resolves it to an `account_id` + `device_id` via **token introspection** (§3.3).

### 3.1 Daemon → relay
```json
{ "t":"hello", "role":"daemon", "protocol_version":1,
  "account_token":"<codegraff device token>",
  "device_label":"my-macbook", "agent_version":"0.4", "schema_version":"<graff --schema version>",
  "capabilities":["create","message","delete","notify","sessions"] }
```
Relay replies:
```json
{ "t":"welcome", "role":"daemon", "daemon_id":"<relay-assigned, stable per device>",
  "account_id":"<opaque>", "heartbeat_sec":30, "protocol_version":1 }
```

### 3.2 Client (phone) → relay
```json
{ "t":"hello", "role":"client", "protocol_version":1,
  "account_token":"<codegraff device token>",
  "push_token":"<ExponentPushToken[...]>", "platform":"ios|android" }
```
Relay replies `welcome` then immediately a `presence` snapshot (§4):
```json
{ "t":"welcome", "role":"client", "client_id":"<relay-assigned>", "account_id":"<opaque>",
  "heartbeat_sec":30, "protocol_version":1 }
```

### 3.3 Token introspection (the one thing muonry owns end-to-end)
The relay MUST resolve a token → identity before sending `welcome`. Expected shape of whatever
muonry endpoint the relay calls internally:
```
POST /internal/token/introspect   { "token": "<account_token>" }
200  { "active":true, "account_id":"acct_…", "device_id":"dev_…", "scopes":["relay"] }
200  { "active":false }            → relay closes with error code "unauthorized"
```
`account_id` is the **tenancy key**. The exact endpoint/format is the owner's call — only the
`account_id`/`device_id` outputs are contractually required here. Cache briefly; honor revocation.

---

## 4. Tenancy & routing — the one invariant that must never break

- The relay maintains `account_id → { daemons, clients }`.
- A `client` frame may only ever reach a `daemon` with the **same `account_id`**, and vice-versa.
- Any `open` targeting a `daemon_id` not in the client's account → relay replies
  `end {status:"error", code:"account_mismatch"}` (or `no_such_daemon`) and forwards **nothing**.
- This MUST have automated tests on both relay and daemon. Cross-account leakage is the only
  truly unacceptable failure.

---

## 5. Presence

Relay → client, on connect (snapshot) and on any change (delta with same shape, treated as replace):
```json
{ "t":"presence", "daemons":[
  { "daemon_id":"…", "device_label":"my-macbook", "online":true,
    "sessions":[ { "session_id":"<16 hex>", "title":"fix auth bug", "busy":false } ] } ] }
```
The session list comes from the daemon's `sessions` frame:
```json
{ "t":"sessions", "list":[ { "session_id":"<16 hex>", "title":"…", "busy":false } ] }
```
Daemon sends `sessions` right after `welcome` and whenever a session is created/deleted or its
`busy` state flips. (`title` MAY be derived from the first user prompt; null until known.)

---

## 6. Channels — the data path

A **channel** carries exactly one request and its streamed events, mirroring one
`POST /v1/sessions[/{id}]` on the existing `graff serve`.

### 6.1 Open (client → relay → daemon)
```json
{ "t":"open", "channel_id":"<client-chosen, unique per client connection>",
  "daemon_id":"<target>", "op":"create|message|delete",
  "session_id":"<16 hex>",          // required for message/delete; omit for create
  "body":{ … } }                    // opaque: create-options for create; one protocol request for message
```
- `op:"create"` → daemon runs `serveCreate`; **the create result `{session_id}` is returned as a
  single `event` then an `end{status:"complete"}`** on this channel (so creation streams uniformly).
- `op:"message"` `body` is exactly one stdio request object:
  `user` / `answer` / `set_model` / `set_mode` / `set_effort` / `set_agent` / `set_fast` /
  `compact` / `set_system_prompt` / `score`.
- `op:"delete"` → graceful close; one `end{status:"complete"}`.
- The relay **namespaces the channel by the originating client** (`(client_id, channel_id)` is
  unique at the daemon) and rewrites to add `client_id` when forwarding to the daemon; it strips
  `client_id` again on the way back. Clients only ever see their own `channel_id`.

### 6.2 Event (daemon → relay → client)
```json
{ "t":"event", "channel_id":"…", "seq":0, "data":{ "type":"text", "text":"…" } }
```
- `data` is one verbatim `graff --json` event (`text`/`reasoning`/`tool_call`/`ask_user`/
  `tool_result`/`turn`/`error`/control-acks). The relay does not interpret it.
- `seq` is monotonic from 0 per channel — lets the client detect gaps/ordering. Relay preserves order.

### 6.3 End
```json
{ "t":"end", "channel_id":"…", "status":"complete|error", "code":"<error code, if error>" }
```
Sent when the request hits its terminal event (`turn`/`error` or a control ack), or on failure.

### 6.4 `answer` is a side-channel (important)
`op:"message"` with `body.type == "answer"` does **not** stream a turn. It is an ack-only channel:
the daemon writes the answer to the child and immediately returns `end{status:"complete"}` on the
answer's channel, **while the original `user` channel keeps streaming** the resulting
`tool_result` and final `turn`. (This matches `serveAnswer` today.) Clients correlate via the
`ask_user` event's `call_id`, not via channels.

### 6.5 Backpressure
One non-`answer` request in flight per session (enforced by the daemon's `busy` mutex). If a client
can't keep up, the relay buffers up to an implementation limit, then drops that channel with
`end{status:"error", code:"slow_consumer"}` (it MUST NOT stall other clients/channels).

---

## 7. Push notifications

Daemon → relay (no agent content, so it survives E2E):
```json
{ "t":"notify", "session_id":"<16 hex>", "kind":"turn_done|needs_input", "title":"fix auth bug" }
```
Relay fans out to **every Expo push token registered for that account** via the Expo Push API.
Suggested push payload (data-only deep link; keep body generic):
```json
{ "to":"ExponentPushToken[…]", "title":"Codegraff", "body":"Turn finished",
  "data":{ "account_id":"…","daemon_id":"…","session_id":"…","kind":"turn_done" } }
```
The daemon decides when to emit `notify` (on `turn` while no client is actively attached, and on
`ask_user`). Push-token lifecycle: registered at `hello`, cleared on explicit logout/unregister.

---

## 8. Heartbeat, reconnect, resilience

- Heartbeat every `heartbeat_sec` (WS ping/pong, or the `ping`/`pong` frames). Miss ~2 intervals → drop.
- **Sessions survive WS reconnects.** `graff --json` children are owned by the daemon *process*,
  not the socket. If the daemon's WS drops, it reconnects with exponential backoff, re-sends `hello`
  then `sessions`; its children keep running. (Matches Claude Code: ~10 min offline → give up.)
- **In-flight streams do NOT replay in v1.** On a daemon WS drop mid-stream, the relay sends
  `end{status:"error", code:"transport_reset"}` to affected clients; the client may re-`open`.
  (An event-replay buffer is a future, additive enhancement.)
- Clients reconnect, re-`hello`, get a fresh `presence`, and re-attach by `session_id`.

---

## 9. Error codes (string `code` on `end`/`error`/`close`)

`unauthorized` · `version_unsupported` · `account_mismatch` · `no_such_daemon` ·
`no_such_session` · `protocol_error` · `slow_consumer` · `transport_reset` · `internal`.

---

## 10. Security considerations (for the relay implementer)

- WSS/TLS only; reject `ws://` in production.
- Enforce the §4 account invariant on **every** forwarded frame, not just at `open`.
- Constant-time token compare where applicable; cache introspection briefly; honor revocation.
- Rate-limit `hello` and `open` per account/IP; cap concurrent daemons/clients/channels per account.
- Treat `body`/`data` as untrusted opaque bytes — never log their contents; size-cap per §1.
- Push tokens are PII-adjacent: store per-device, purge on logout, never cross accounts.

---

## 11. E2E forward-compat (Phase 7, not v1)

Designed so encryption is additive: only `open.body` and `event.data` become ciphertext (a single
`{"enc":"x25519-xsalsa20poly1305","ct":"<b64>"}` value); all routing/identity/`notify` fields stay
plaintext so the relay keeps routing and pushing without seeing content. No frame-shape change.

---

## 12. Ownership split

| Party | Owns |
|-------|------|
| **muonry / relay (owner)** | the relay service: §3 handshake + introspection wiring, §4 routing/isolation, §5–§9 forwarding, §7 Expo push fan-out, §10 hardening |
| **codegraff-zig (us)** | `graff serve --relay` daemon: §3.1 hello, §5 `sessions`, §6 channel handlers (reusing `serveCreate/serveMessage/serveDelete`), §7 `notify` emission, §8 reconnect |
| **mobile app (us)** | Expo client: §3.2 hello + device-auth pairing, §5 presence UI, §6 channel open + event rendering, §7 push-token registration + deep-link |
| **`relay-dev/` (us)** | a faithful reference relay implementing this doc, for local end-to-end dev before the production relay ships |
```
