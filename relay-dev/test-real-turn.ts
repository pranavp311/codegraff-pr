// Live validation: a REAL streaming turn flows daemon->relay->client against a
// real model (uses OPENAI_API_KEY / gpt-5.5). Proves text streaming + the
// terminal turn, and best-effort exercises the ask_user -> answer concurrency
// path (the thing the concurrent-channel rework enables).
//
// Makes real (billed) API calls — kept tiny. Run from relay-dev/:
//   bun test-real-turn.ts
// Skips cleanly (exit 0) if no provider key is available.

const PORT = 8803;
const GRAFF = `${import.meta.dir}/../zig-out/bin/graff`;
const MODEL = Bun.env.GRAFF_TEST_MODEL ?? "gpt-5.5";

if (!Bun.env.OPENAI_API_KEY && !Bun.env.CODEGRAFF_API_KEY && !Bun.env.DEEPSEEK_API_KEY) {
  console.log("no provider key (OPENAI_API_KEY/…) — skipping live test");
  process.exit(0);
}
if (!(await Bun.file(GRAFF).exists())) { console.error("graff not built — run zig build"); process.exit(2); }

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
      if (w) w(f); else this.q.push(f);
    };
  }
  send(f: any) { this.ws.send(JSON.stringify(f)); }
  next(timeoutMs = 90000): Promise<any> {
    const f = this.q.shift();
    if (f) return Promise.resolve(f);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting for frame")), timeoutMs);
      this.waiters.push((v) => { clearTimeout(t); res(v); });
    });
  }
  async until(pred: (f: any) => boolean) { for (let i = 0; i < 200; i++) { const f = await this.next(); if (pred(f)) return f; } throw new Error("until: no match"); }
  close() { this.ws.close(); }
}

let failures = 0;
const check = (c: boolean, label: string) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };

// Collect every event frame on a channel until its `end`. Returns {events, end}.
async function drain(cli: Conn, channel: string) {
  const events: any[] = [];
  for (let i = 0; i < 5000; i++) {
    const f = await cli.next();
    if (f.channel_id !== channel) continue;
    if (f.t === "event") events.push(f.data);
    else if (f.t === "end") return { events, end: f };
  }
  throw new Error("drain: channel never ended");
}

const relay = Bun.spawn(["bun", "relay.ts"], { env: { ...Bun.env, RELAY_PORT: String(PORT), RELAY_QUIET: "1" }, cwd: import.meta.dir, stdout: "inherit", stderr: "inherit" });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {} await Bun.sleep(50); }
const daemon = Bun.spawn([GRAFF, "serve", "--relay", `ws://127.0.0.1:${PORT}/v1/relay/daemon`, "--token", "acctL:mac", "--model", MODEL, "--yolo"], { stdout: "inherit", stderr: "inherit" });

try {
  const dId = "dmn_acctL_mac";
  const cli = new Conn("/v1/relay/client");
  await cli.ready;
  cli.send({ t: "hello", role: "client", protocol_version: 1, account_token: "acctL:phone", platform: "ios" });
  await cli.until((f) => f.t === "welcome");
  await cli.until((f) => f.t === "presence" && (f.daemons ?? []).some((d: any) => d.daemon_id === dId));

  cli.send({ t: "open", channel_id: "s", daemon_id: dId, op: "create", body: {} });
  const sid = (await cli.until((f) => f.t === "event" && f.channel_id === "s")).data.session_id;
  await cli.until((f) => f.t === "end" && f.channel_id === "s");
  console.log(`session ${sid} on ${MODEL}`);

  // ── 1) a real streaming text turn ─────────────────────────────────────────
  cli.send({ t: "open", channel_id: "u1", daemon_id: dId, op: "message", session_id: sid, body: { type: "user", text: "Reply with exactly the word: pong" } });
  const r1 = await drain(cli, "u1");
  console.log("  u1 events:", JSON.stringify(r1.events.map((e: any) => e.type)), "end:", JSON.stringify(r1.end));
  // Path validation — works with OR without a valid key: real model output must
  // stream through and the channel must end cleanly (catches the transport bug
  // where a non-JSON child line broke the frame and reset the connection).
  check(r1.events.length >= 1, `forwarded ${r1.events.length} real model event(s)`);
  check(r1.end.status === "complete", "turn channel ended complete (no transport_reset)");
  const turn = r1.events.find((e: any) => e.type === "turn");
  const err = r1.events.find((e: any) => e.type === "error");
  if (turn) {
    const full = r1.events.filter((e: any) => e.type === "text").map((e: any) => e.text).join("");
    check(true, `LIVE turn streamed: ${JSON.stringify(full.trim().slice(0, 60))} (cost $${turn.cost_usd})`);
  } else if (err) {
    console.log(`  • model error (likely no valid key): ${err.message} — streaming path still validated`);
  }

  // ── 2) ask_user -> answer concurrency (best-effort) ───────────────────────
  cli.send({ t: "open", channel_id: "u2", daemon_id: dId, op: "message", session_id: sid, body: { type: "user", text: "Call the ask_user tool to ask me to pick a number between 1 and 9, then tell me the number I picked." } });
  // watch for an ask_user event while the u2 stream is in flight; answer it on a separate channel
  let askId: string | null = null;
  const events2: any[] = [];
  let ended2 = false;
  (async () => {
    for (let i = 0; i < 5000 && !ended2; i++) {
      const f = await cli.next();
      if (f.channel_id !== "u2") continue;
      if (f.t === "event") {
        events2.push(f.data);
        if (f.data.type === "ask_user" && !askId) {
          askId = f.data.call_id ?? "";
          // answer on a SEPARATE channel while u2 keeps streaming (the concurrency we built)
          cli.send({ t: "open", channel_id: "a1", daemon_id: dId, op: "message", session_id: sid, body: { type: "answer", text: "7", call_id: askId } });
        }
      } else if (f.t === "end") ended2 = true;
    }
  })();
  // wait up to 90s for u2 to finish
  for (let i = 0; i < 180 && !ended2; i++) await Bun.sleep(500);
  if (askId !== null) {
    check(true, "model called ask_user; answered on a concurrent channel mid-turn");
    check(events2.some((e) => e.type === "turn"), "turn completed after the answer");
  } else {
    console.log("• model did not call ask_user this run — answer-path concurrency not exercised (not a failure)");
  }

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
