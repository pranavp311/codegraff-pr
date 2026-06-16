# relay-dev — reference relay

A faithful, local-dev implementation of [`PROTOCOL.md`](./PROTOCOL.md) (v1), so the
`graff serve --relay` daemon and the Expo app can be developed end-to-end **before** the production
relay ([justrach/muonry#2](https://github.com/justrach/muonry/issues/2)) ships. This is the
executable spec — the production relay must match its wire behaviour.

```bash
bun relay.ts          # start on :8788 (RELAY_PORT to change)
bun test-isolation.ts # automated tenancy + routing guard
```

**Dev auth only:** a token is literally `"<account_id>:<device_id>"` (e.g. `acctA:macbook`).
Production swaps `introspect()` for a real muonry token-introspection call (PROTOCOL.md §3.3).
Set `EXPO_PUSH=1` to actually send Expo pushes on `notify`; default just logs.

Endpoints: `ws://127.0.0.1:8788/v1/relay/daemon`, `ws://127.0.0.1:8788/v1/relay/client`, `GET /healthz`.

Not for production: no TLS, no rate limiting, no persistence, no real introspection — those are the
muonry relay's job (PROTOCOL.md §10, §12).
