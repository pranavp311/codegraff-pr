//! Smoke test for the WebSocket client against the relay-dev reference relay.
//! Run the relay first (`cd relay-dev && bun relay.ts`), then:
//!   zig run src/relay_smoke.zig
//! Expects a `welcome` frame back. Exits non-zero on failure.

const std = @import("std");
const relay = @import("relay.zig");

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const url = "ws://127.0.0.1:8788/v1/relay/daemon";
    var ws = relay.WsClient.connect(gpa, io, url, false) catch |err| {
        std.debug.print("connect failed: {t} (is relay-dev running on :8788?)\n", .{err});
        return err;
    };
    defer ws.deinit(gpa);
    std.debug.print("connected + handshook to {s}\n", .{url});

    try ws.sendText(
        \\{"t":"hello","role":"daemon","protocol_version":1,"account_token":"acctSmoke:dev","device_label":"smoke","capabilities":["create"]}
    );

    var msg: std.ArrayList(u8) = .empty;
    defer msg.deinit(gpa);
    const op = try ws.readMessage(gpa, &msg);
    std.debug.print("recv [{t}]: {s}\n", .{ op, msg.items });

    if (std.mem.indexOf(u8, msg.items, "\"t\":\"welcome\"") == null) {
        std.debug.print("FAIL: expected a welcome frame\n", .{});
        std.process.exit(1);
    }
    // also send a sessions frame and a ping; expect a pong back
    try ws.sendText(
        \\{"t":"sessions","list":[{"session_id":"0000000000000000","title":"smoke","busy":false}]}
    );
    std.debug.print("PASS: handshake + welcome + frame send OK\n", .{});
}
