// Reference relay for the codegraff mobile feature — a faithful, local-dev
// implementation of relay-dev/PROTOCOL.md (v1). It exists so the daemon
// (`graff serve --relay`) and the Expo app can be developed end-to-end before
// the production relay (justrach/muonry#2) ships. The muonry implementation
// must match this wire behaviour; this file is the executable spec.
//
// Run: `bun relay.ts` (PORT env, default 8788). Dev auth only — see introspect().

const PORT = Number(Bun.env.RELAY_PORT ?? 8788);
const PROTOCOL_VERSION = 1;
const HEARTBEAT_SEC = 30;

// ── Dev token introspection ────────────────────────────────────────────────
// Production: the relay calls a muonry endpoint (see PROTOCOL.md §3.3). For
// local dev a token is literally "<account_id>:<device_id>", so two daemons on
// different accounts are trivially expressible in tests. Anything without a ':'
// is inactive.
function introspect(token: string): { active: boolean; account_id?: string; device_id?: string } {
  const i = token.indexOf(":");
  if (i <= 0 || i === token.length - 1) return { active: false };
  return { active: true, account_id: token.slice(0, i), device_id: token.slice(i + 1) };
}

type Json = Record<string, unknown>;

interface Daemon {
  ws: Bun.ServerWebSocket<SockData>;
  daemonId: string;
  accountId: string;
  deviceLabel: string;
  sessions: Json[]; // last `sessions` list snapshot
}
interface Client {
  ws: Bun.ServerWebSocket<SockData>;
  clientId: string;
  accountId: string;
  pushToken?: string;
  channels: Map<string, string>; // channel_id -> daemon_id (for routing + cleanup)
}

const daemons = new Map<string, Daemon>(); // daemon_id -> Daemon
const clients = new Map<string, Client>(); // client_id -> Client

interface SockData {
  role: "daemon" | "client" | "pending";
  id?: string; // daemon_id or client_id once welcomed
}

let idCounter = 0;
const newId = (p: string) => `${p}_${(idCounter++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function send(ws: Bun.ServerWebSocket<SockData>, frame: Json) {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* socket gone */
  }
}
function closeWith(ws: Bun.ServerWebSocket<SockData>, code: string, reason: string) {
  send(ws, { t: "close", code, reason });
  try {
    ws.close();
  } catch {}
}

// ── Presence (PROTOCOL.md §5) ────────────────────────────────────────────────
function presenceFor(accountId: string): Json {
  const list: Json[] = [];
  for (const d of daemons.values()) {
    if (d.accountId !== accountId) continue;
    list.push({ daemon_id: d.daemonId, device_label: d.deviceLabel, online: true, sessions: d.sessions });
  }
  return { t: "presence", daemons: list };
}
function broadcastPresence(accountId: string) {
  const frame = presenceFor(accountId);
  for (const c of clients.values()) if (c.accountId === accountId) send(c.ws, frame);
}

// ── Handshake (PROTOCOL.md §3) ───────────────────────────────────────────────
function onHello(ws: Bun.ServerWebSocket<SockData>, f: Json) {
  if (f.protocol_version !== PROTOCOL_VERSION)
    return closeWith(ws, "version_unsupported", `relay speaks protocol_version ${PROTOCOL_VERSION}`);
  const token = typeof f.account_token === "string" ? f.account_token : "";
  const id = introspect(token);
  if (!id.active) return closeWith(ws, "unauthorized", "token introspection: inactive");
  const accountId = id.account_id!;

  if (f.role === "daemon") {
    // daemon_id is stable per device within an account.
    const daemonId = `dmn_${accountId}_${id.device_id}`;
    const d: Daemon = {
      ws,
      daemonId,
      accountId,
      deviceLabel: typeof f.device_label === "string" ? f.device_label : id.device_id!,
      sessions: [],
    };
    daemons.set(daemonId, d);
    ws.data = { role: "daemon", id: daemonId };
    send(ws, { t: "welcome", role: "daemon", daemon_id: daemonId, account_id: accountId, heartbeat_sec: HEARTBEAT_SEC, protocol_version: PROTOCOL_VERSION });
    broadcastPresence(accountId);
    log(`daemon ${daemonId} (${d.deviceLabel}) online`);
  } else if (f.role === "client") {
    const clientId = newId("cli");
    const c: Client = {
      ws,
      clientId,
      accountId,
      pushToken: typeof f.push_token === "string" ? f.push_token : undefined,
      channels: new Map(),
    };
    clients.set(clientId, c);
    ws.data = { role: "client", id: clientId };
    send(ws, { t: "welcome", role: "client", client_id: clientId, account_id: accountId, heartbeat_sec: HEARTBEAT_SEC, protocol_version: PROTOCOL_VERSION });
    send(ws, presenceFor(accountId)); // snapshot immediately after welcome
    log(`client ${clientId} online (account ${accountId})`);
  } else {
    closeWith(ws, "protocol_error", "hello.role must be 'daemon' or 'client'");
  }
}

// ── Client → daemon: open (PROTOCOL.md §6.1, §4) ─────────────────────────────
function onClientOpen(c: Client, f: Json) {
  const channelId = f.channel_id;
  const daemonId = f.daemon_id;
  if (typeof channelId !== "string" || typeof daemonId !== "string")
    return send(c.ws, { t: "error", code: "protocol_error", message: "open needs channel_id + daemon_id" });

  const d = daemons.get(daemonId);
  // The tenancy invariant: a client may only reach a daemon of its own account.
  if (!d || d.accountId !== c.accountId)
    return send(c.ws, { t: "end", channel_id: channelId, status: "error", code: d ? "account_mismatch" : "no_such_daemon" });

  c.channels.set(channelId, daemonId);
  // Forward with client_id added so (client_id, channel_id) is unique at the daemon.
  send(d.ws, { ...f, client_id: c.clientId });
}

// ── Daemon → client: event / end / sessions / notify ─────────────────────────
function onDaemonFrame(d: Daemon, f: Json) {
  switch (f.t) {
    case "sessions": {
      d.sessions = Array.isArray(f.list) ? (f.list as Json[]) : [];
      broadcastPresence(d.accountId);
      return;
    }
    case "event":
    case "end": {
      const clientId = f.client_id;
      const c = typeof clientId === "string" ? clients.get(clientId) : undefined;
      if (!c || c.accountId !== d.accountId) return; // never cross accounts
      const { client_id, ...out } = f; // strip client_id on the way back
      send(c.ws, out);
      if (f.t === "end" && typeof f.channel_id === "string") c.channels.delete(f.channel_id);
      return;
    }
    case "notify":
      return fanoutPush(d.accountId, f);
    default:
      return; // unknown frame types ignored (forward-compat)
  }
}

// ── Push fan-out (PROTOCOL.md §7) — dev stub ─────────────────────────────────
async function fanoutPush(accountId: string, f: Json) {
  const tokens = new Set<string>();
  for (const c of clients.values()) if (c.accountId === accountId && c.pushToken) tokens.add(c.pushToken);
  const kind = f.kind === "needs_input" ? "needs_input" : "turn_done";
  const body = kind === "needs_input" ? "Claude needs your input" : "Turn finished";
  log(`push → account ${accountId} [${kind}] session=${f.session_id} → ${tokens.size} device(s)`);
  if (!Bun.env.EXPO_PUSH) return; // dev default: just log
  for (const to of tokens) {
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, title: "Codegraff", body, data: { account_id: accountId, daemon_id: f.daemon_id, session_id: f.session_id, kind } }),
      });
    } catch (e) {
      log(`push send failed: ${e}`);
    }
  }
}

// ── Disconnect cleanup ───────────────────────────────────────────────────────
function onClose(ws: Bun.ServerWebSocket<SockData>) {
  const { role, id } = ws.data ?? {};
  if (role === "daemon" && id) {
    const d = daemons.get(id);
    daemons.delete(id);
    if (d) {
      // Tell affected clients their in-flight channels reset (no replay in v1).
      for (const c of clients.values()) {
        if (c.accountId !== d.accountId) continue;
        for (const [chId, dmnId] of c.channels) if (dmnId === id) {
          send(c.ws, { t: "end", channel_id: chId, status: "error", code: "transport_reset" });
          c.channels.delete(chId);
        }
      }
      broadcastPresence(d.accountId);
      log(`daemon ${id} offline`);
    }
  } else if (role === "client" && id) {
    clients.delete(id);
    log(`client ${id} offline`);
  }
}

function log(msg: string) {
  if (Bun.env.RELAY_QUIET) return;
  console.log(`[relay] ${msg}`);
}

// Optional TLS (dev): RELAY_TLS_CERT/RELAY_TLS_KEY point at PEM files. Used by
// test-tls.ts to give the daemon a wss:// target (self-signed; daemon connects
// with --relay-insecure).
const tlsOpt = Bun.env.RELAY_TLS_CERT && Bun.env.RELAY_TLS_KEY
  ? { tls: { cert: Bun.file(Bun.env.RELAY_TLS_CERT), key: Bun.file(Bun.env.RELAY_TLS_KEY) } }
  : {};

const server = Bun.serve<SockData, {}>({
  port: PORT,
  ...tlsOpt,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, protocol_version: PROTOCOL_VERSION, daemons: daemons.size, clients: clients.size });
    if (url.pathname === "/v1/relay/daemon" || url.pathname === "/v1/relay/client") {
      if (server.upgrade(req, { data: { role: "pending" } })) return undefined;
      return new Response("expected websocket upgrade", { status: 426 });
    }
    return new Response("not found — see relay-dev/PROTOCOL.md", { status: 404 });
  },
  websocket: {
    maxPayloadLength: 9 * 1024 * 1024, // PROTOCOL.md §1 size caps
    message(ws, raw) {
      let f: Json;
      try {
        f = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        return closeWith(ws, "protocol_error", "each message must be one JSON object");
      }
      const data = ws.data;
      if (data.role === "pending") {
        if (f.t !== "hello") return closeWith(ws, "protocol_error", "first frame must be hello");
        return onHello(ws, f);
      }
      if (f.t === "ping") return send(ws, { t: "pong" });
      if (data.role === "daemon") {
        const d = daemons.get(data.id!);
        if (d) onDaemonFrame(d, f);
      } else if (data.role === "client") {
        const c = clients.get(data.id!);
        if (!c) return;
        if (f.t === "open") onClientOpen(c, f);
        // clients send only hello/open/ping in v1; ignore the rest.
      }
    },
    close(ws) {
      onClose(ws);
    },
  },
});

log(`reference relay listening on :${server.port} (protocol_version ${PROTOCOL_VERSION})`);
log(`  daemon WSS  ws://127.0.0.1:${server.port}/v1/relay/daemon`);
log(`  client WSS  ws://127.0.0.1:${server.port}/v1/relay/client`);
