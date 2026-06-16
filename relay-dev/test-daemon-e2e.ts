// End-to-end: relay-dev + the real `graff serve --relay` daemon + a mock phone
// client. Proves the daemon dials out, registers, appears in presence, and that
// a session `create` (then `delete`) round-trips over the relay as event/end
// frames. (A full user turn needs a provider key, so it's not exercised here.)
//
// Run from relay-dev/: `bun test-daemon-e2e.ts`  (exits non-zero on failure)

const PORT = 8801;
const GRAFF = `${import.meta.dir}/../zig-out/bin/graff`;

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
  send(f: any) { this.ws.send(JSON.stringify(f)); }
  next(): Promise<any> {
    const f = this.q.shift();
    return f ? Promise.resolve(f) : new Promise((res) => this.waiters.push(res));
  }
  async until(pred: (f: any) => boolean): Promise<any> {
    for (let i = 0; i < 80; i++) { const f = await this.next(); if (pred(f)) return f; }
    throw new Error("until: no matching frame");
  }
  close() { this.ws.close(); }
}

let failures = 0;
const check = (c: boolean, label: string) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };

if (!(await Bun.file(GRAFF).exists())) {
  console.error(`graff binary not found at ${GRAFF} — run \`zig build\` first`);
  process.exit(2);
}

const relay = Bun.spawn(["bun", "relay.ts"], { env: { ...Bun.env, RELAY_PORT: String(PORT), RELAY_QUIET: "1" }, cwd: import.meta.dir, stdout: "inherit", stderr: "inherit" });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {} await Bun.sleep(50); }

const daemon = Bun.spawn([GRAFF, "serve", "--relay", `ws://127.0.0.1:${PORT}/v1/relay/daemon`, "--token", "acctX:mac"], { stdout: "inherit", stderr: "inherit" });

try {
  const dId = "dmn_acctX_mac";
  // client for the same account
  const cli = new Conn("/v1/relay/client");
  await cli.ready;
  cli.send({ t: "hello", role: "client", protocol_version: 1, account_token: "acctX:phone", platform: "ios" });
  await cli.until((f) => f.t === "welcome");
  await cli.until((f) => f.t === "presence" && (f.daemons ?? []).some((d: any) => d.daemon_id === dId));
  check(true, "real daemon dialed out and appears in presence");

  // create a session over the relay
  cli.send({ t: "open", channel_id: "c1", daemon_id: dId, op: "create", body: {} });
  const ev = await cli.until((f) => f.t === "event" && f.channel_id === "c1");
  const sid = ev.data?.session_id;
  check(typeof sid === "string" && /^[0-9a-f]{16}$/.test(sid), `create returned a session_id (${sid})`);
  const end1 = await cli.until((f) => f.t === "end" && f.channel_id === "c1");
  check(end1.status === "complete", "create channel ends complete");

  // presence should now list the new session
  const pres = await cli.until((f) => f.t === "presence" && (f.daemons ?? []).some((d: any) => (d.sessions ?? []).some((s: any) => s.session_id === sid)));
  check(!!pres, "new session shows in presence");

  // delete it
  cli.send({ t: "open", channel_id: "c2", daemon_id: dId, op: "delete", session_id: sid, body: {} });
  const end2 = await cli.until((f) => f.t === "end" && f.channel_id === "c2");
  check(end2.status === "complete", "delete channel ends complete");

  cli.close();
} catch (e) {
  console.error("test error:", e);
  failures++;
} finally {
  daemon.kill();
  relay.kill();
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
