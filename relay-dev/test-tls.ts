// wss:// end-to-end: relay-dev over TLS (self-signed) + the real daemon with
// `--relay-insecure` + a mock client. Validates the daemon's TLS layer and that
// framing works over an encrypted transport. Requires `openssl` for the cert.
//
// Run from relay-dev/: `bun test-tls.ts`  (exits non-zero on failure)

const PORT = 8802;
const GRAFF = `${import.meta.dir}/../zig-out/bin/graff`;
const CERT = `${import.meta.dir}/.dev-cert.pem`;
const KEY = `${import.meta.dir}/.dev-key.pem`;

class Conn {
  ws: WebSocket;
  private q: any[] = [];
  private waiters: ((v: any) => void)[] = [];
  ready: Promise<void>;
  constructor(path: string) {
    this.ws = new WebSocket(`wss://127.0.0.1:${PORT}${path}`); // NODE_TLS_REJECT_UNAUTHORIZED=0 for self-signed
    this.ready = new Promise((res) => (this.ws.onopen = () => res()));
    this.ws.onmessage = (e) => {
      const f = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
      const w = this.waiters.shift();
      if (w) w(f); else this.q.push(f);
    };
  }
  send(f: any) { this.ws.send(JSON.stringify(f)); }
  next(): Promise<any> { const f = this.q.shift(); return f ? Promise.resolve(f) : new Promise((r) => this.waiters.push(r)); }
  async until(pred: (f: any) => boolean) { for (let i = 0; i < 80; i++) { const f = await this.next(); if (pred(f)) return f; } throw new Error("until: no match"); }
  close() { this.ws.close(); }
}

let failures = 0;
const check = (c: boolean, label: string) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };

if (!(await Bun.file(GRAFF).exists())) { console.error(`graff not built — run zig build`); process.exit(2); }

// self-signed cert valid for localhost/127.0.0.1
const gen = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", KEY, "-out", CERT, "-days", "1", "-nodes", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdout: "ignore", stderr: "ignore" });
if (gen.exitCode !== 0) { console.error("openssl failed — is it installed?"); process.exit(2); }

const relay = Bun.spawn(["bun", "relay.ts"], { env: { ...Bun.env, RELAY_PORT: String(PORT), RELAY_QUIET: "1", RELAY_TLS_CERT: CERT, RELAY_TLS_KEY: KEY }, cwd: import.meta.dir, stdout: "inherit", stderr: "inherit" });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`https://127.0.0.1:${PORT}/healthz`, { tls: { rejectUnauthorized: false } } as any)).ok) break; } catch {} await Bun.sleep(50); }

const daemon = Bun.spawn([GRAFF, "serve", "--relay", `wss://127.0.0.1:${PORT}/v1/relay/daemon`, "--relay-insecure", "--token", "acctT:mac"], { stdout: "inherit", stderr: "inherit" });

try {
  const dId = "dmn_acctT_mac";
  const cli = new Conn("/v1/relay/client");
  await cli.ready;
  check(true, "client established a wss connection to the relay");
  cli.send({ t: "hello", role: "client", protocol_version: 1, account_token: "acctT:phone", platform: "ios" });
  await cli.until((f) => f.t === "welcome");
  await cli.until((f) => f.t === "presence" && (f.daemons ?? []).some((d: any) => d.daemon_id === dId));
  check(true, "real daemon connected over wss (TLS) and appears in presence");

  cli.send({ t: "open", channel_id: "t1", daemon_id: dId, op: "create", body: {} });
  const ev = await cli.until((f) => f.t === "event" && f.channel_id === "t1");
  check(/^[0-9a-f]{16}$/.test(ev.data?.session_id ?? ""), "create round-trips over TLS");
  const end = await cli.until((f) => f.t === "end" && f.channel_id === "t1");
  check(end.status === "complete", "channel ends complete over TLS");
  cli.close();
} catch (e) {
  console.error("test error:", e);
  failures++;
} finally {
  daemon.kill();
  relay.kill();
  try { await Bun.file(CERT).delete(); await Bun.file(KEY).delete(); } catch {}
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
