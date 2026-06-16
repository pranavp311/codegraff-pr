// Automated guard for the one invariant that must never break (PROTOCOL.md §4):
// a client may only ever reach a daemon of its OWN account. Also exercises the
// happy-path routing (open → event → end) with a mock daemon, proving channel
// namespacing works without the real Zig daemon.
//
// Run: `bun test-isolation.ts`  (exits non-zero on any failure)

const PORT = 8799;

// ── tiny awaitable WS client ────────────────────────────────────────────────
class Conn {
  ws: WebSocket;
  private q: any[] = [];
  private waiters: ((v: any) => void)[] = [];
  ready: Promise<void>;
  constructor(path: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    this.ready = new Promise((res) => (this.ws.onopen = () => res()));
    this.ws.onmessage = (e) => {
      const f = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
      const w = this.waiters.shift();
      if (w) w(f);
      else this.q.push(f);
    };
  }
  send(f: any) {
    this.ws.send(JSON.stringify(f));
  }
  next(): Promise<any> {
    const f = this.q.shift();
    if (f) return Promise.resolve(f);
    return new Promise((res) => this.waiters.push(res));
  }
  // await a frame matching predicate (skips others, e.g. presence churn)
  async until(pred: (f: any) => boolean): Promise<any> {
    for (let i = 0; i < 50; i++) {
      const f = await this.next();
      if (pred(f)) return f;
    }
    throw new Error("until: no matching frame in 50 frames");
  }
  close() {
    this.ws.close();
  }
}

let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

// ── mock daemon: echoes one event + end per open (happy-path routing) ────────
function mockDaemon(token: string, deviceLabel: string): Conn {
  const c = new Conn("/v1/relay/daemon");
  c.ready.then(() => {
    c.send({ t: "hello", role: "daemon", protocol_version: 1, account_token: token, device_label: deviceLabel, capabilities: ["create", "message", "delete"] });
  });
  c.ws.addEventListener("message", (e: any) => {
    const f = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
    if (f.t === "welcome") c.send({ t: "sessions", list: [{ session_id: "0000000000000000", title: "demo", busy: false }] });
    if (f.t === "open") {
      // echo a single event then end, preserving channel_id + client_id
      c.send({ t: "event", channel_id: f.channel_id, client_id: f.client_id, seq: 0, data: { type: "text", text: `echo:${f.op}` } });
      c.send({ t: "end", channel_id: f.channel_id, client_id: f.client_id, status: "complete" });
    }
  });
  return c;
}

const proc = Bun.spawn(["bun", "relay.ts"], { env: { ...Bun.env, RELAY_PORT: String(PORT), RELAY_QUIET: "1" }, cwd: import.meta.dir, stdout: "inherit", stderr: "inherit" });

// wait for the relay to accept connections
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if (r.ok) break;
  } catch {}
  await Bun.sleep(50);
}

try {
  const dA = mockDaemon("acctA:macbook", "A-mac");
  const dB = mockDaemon("acctB:thinkpad", "B-pad");
  await dA.until((f) => f.t === "welcome");
  const dAId = (await fetch(`http://127.0.0.1:${PORT}/healthz`)) && `dmn_acctA_macbook`;
  const dBId = `dmn_acctB_thinkpad`;
  await dB.until((f) => f.t === "welcome");
  await Bun.sleep(100); // let sessions frames land

  // client for account A
  const cA = new Conn("/v1/relay/client");
  await cA.ready;
  cA.send({ t: "hello", role: "client", protocol_version: 1, account_token: "acctA:phone", push_token: "ExponentPushToken[dev]", platform: "ios" });
  await cA.until((f) => f.t === "welcome");
  const presence = await cA.until((f) => f.t === "presence");

  const seen = (presence.daemons ?? []).map((d: any) => d.daemon_id);
  check(seen.includes(dAId), "client A presence includes its own account's daemon");
  check(!seen.includes(dBId), "client A presence EXCLUDES account B's daemon (isolation)");

  // happy path: open to own daemon → event + end
  cA.send({ t: "open", channel_id: "ch1", daemon_id: dAId, op: "create", body: { model: "deepseek-v4-pro" } });
  const ev = await cA.until((f) => f.t === "event" && f.channel_id === "ch1");
  check(ev.data?.text === "echo:create", "open to own daemon routes back an event");
  check(ev.client_id === undefined, "client_id is stripped from frames sent to the client");
  const end1 = await cA.until((f) => f.t === "end" && f.channel_id === "ch1");
  check(end1.status === "complete", "own-daemon channel ends complete");

  // isolation: open to account B's daemon → account_mismatch, daemon B sees nothing
  let bGotOpen = false;
  dB.ws.addEventListener("message", (e: any) => {
    const f = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
    if (f.t === "open") bGotOpen = true;
  });
  cA.send({ t: "open", channel_id: "ch2", daemon_id: dBId, op: "create", body: {} });
  const end2 = await cA.until((f) => f.t === "end" && f.channel_id === "ch2");
  check(end2.status === "error" && end2.code === "account_mismatch", "cross-account open is rejected with account_mismatch");
  await Bun.sleep(100);
  check(!bGotOpen, "account B's daemon received NO frame from account A's client");

  cA.close();
  dA.close();
  dB.close();
} catch (e) {
  console.error("test error:", e);
  failures++;
} finally {
  proc.kill();
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
