//! Minimal WebSocket client (RFC 6455) for `graff serve --relay`: the daemon
//! dials OUT to the cloud relay (relay-dev/PROTOCOL.md), so no inbound ports.
//! Just what the daemon needs — text frames, client masking, ping/pong, close,
//! fragmentation reassembly. One message in / one message out at a time
//! (the daemon serializes per session anyway).
//!
//! Supports ws:// (plain TCP) and wss:// (TLS via std.crypto.tls.Client layered
//! over the stream). `insecure` disables cert/host verification for connecting
//! to a self-signed dev relay; production wss:// uses the system CA bundle.

const std = @import("std");
const Io = std.Io;
const net = std.Io.net;
const Allocator = std.mem.Allocator;
const tls = std.crypto.tls;

pub const Opcode = enum(u4) {
    cont = 0x0,
    text = 0x1,
    binary = 0x2,
    close = 0x8,
    ping = 0x9,
    pong = 0xA,
    _,
};

pub const Error = error{
    BadUrl,
    HandshakeFailed,
    PeerClosed,
    MessageTooLong,
    StreamTooLong,
} || Allocator.Error || Io.Reader.Error || Io.Writer.Error;

// Encrypted/raw socket buffers (TLS asserts these are >= tls min_buffer_len).
const sock_buf_cap = 64 * 1024;
// Plaintext TLS buffers.
const tls_buf_cap = 64 * 1024;
/// Hard cap on one reassembled inbound message (matches the daemon's
/// serve_line_cap intent: a tool_result event is the realistic worst case).
const message_cap = 1024 * 1024;

comptime {
    if (sock_buf_cap < tls.max_ciphertext_record_len) @compileError("sock_buf_cap < tls min_buffer_len");
}

pub const WsClient = struct {
    io: Io,
    stream: net.Stream,
    rd: net.Stream.Reader,
    wr: net.Stream.Writer,
    // Active plaintext interfaces: raw stream for ws://, TLS plaintext for wss://.
    r: *Io.Reader = undefined,
    w: *Io.Writer = undefined,
    tls_client: ?tls.Client = null,
    ca_bundle: std.crypto.Certificate.Bundle = .empty,
    ca_lock: Io.RwLock = .init,
    gpa: Allocator,
    sock_rbuf: [sock_buf_cap]u8 = undefined,
    sock_wbuf: [sock_buf_cap]u8 = undefined,
    tls_rbuf: [tls_buf_cap]u8 = undefined,
    tls_wbuf: [tls_buf_cap]u8 = undefined,

    /// Connect + (for wss) TLS handshake + the HTTP Upgrade handshake.
    /// Heap-allocated and stable (the Reader/Writer interfaces and the TLS
    /// client reference its inline buffers and each other).
    pub fn connect(gpa: Allocator, io: Io, url: []const u8, insecure: bool) Error!*WsClient {
        const u = parseUrl(url) orelse return error.BadUrl;

        const addr = net.IpAddress.resolve(io, u.host, u.port) catch return error.HandshakeFailed;
        const stream = net.IpAddress.connect(&addr, io, .{ .mode = .stream }) catch return error.HandshakeFailed;

        const self = try gpa.create(WsClient);
        errdefer gpa.destroy(self);
        self.* = .{ .io = io, .stream = stream, .rd = undefined, .wr = undefined, .gpa = gpa };
        self.rd = net.Stream.Reader.init(stream, io, &self.sock_rbuf);
        self.wr = net.Stream.Writer.init(stream, io, &self.sock_wbuf);

        if (u.tls) {
            var entropy: [tls.Client.Options.entropy_len]u8 = undefined;
            io.random(&entropy);
            if (!insecure) self.ca_bundle.rescan(gpa, io, Io.Clock.real.now(io)) catch return error.HandshakeFailed;
            self.tls_client = tls.Client.init(&self.rd.interface, &self.wr.interface, .{
                .host = if (insecure) .no_verification else .{ .explicit = u.host },
                .ca = if (insecure) .no_verification else .{ .bundle = .{
                    .gpa = gpa,
                    .io = io,
                    .lock = &self.ca_lock,
                    .bundle = &self.ca_bundle,
                } },
                .write_buffer = &self.tls_wbuf,
                .read_buffer = &self.tls_rbuf,
                .entropy = &entropy,
                .realtime_now = Io.Clock.real.now(io),
            }) catch return error.HandshakeFailed;
            self.r = &self.tls_client.?.reader;
            self.w = &self.tls_client.?.writer;
        } else {
            self.r = &self.rd.interface;
            self.w = &self.wr.interface;
        }

        try self.handshake(u);
        return self;
    }

    pub fn deinit(self: *WsClient, gpa: Allocator) void {
        self.sendFrame(.close, "") catch {};
        self.ca_bundle.deinit(gpa);
        self.stream.close(self.io);
        gpa.destroy(self);
    }

    /// Send one text message.
    pub fn sendText(self: *WsClient, payload: []const u8) Error!void {
        return self.sendFrame(.text, payload);
    }

    /// Read one complete (re-assembled) message into `out`. Control frames
    /// (ping/pong/close) are handled internally; a peer close → error.PeerClosed.
    /// Returns the message opcode (.text or .binary).
    pub fn readMessage(self: *WsClient, gpa: Allocator, out: *std.ArrayList(u8)) Error!Opcode {
        out.clearRetainingCapacity();
        var msg_op: ?Opcode = null;
        const r = self.r;
        while (true) {
            const h = try r.takeArray(2);
            const fin = (h[0] & 0x80) != 0;
            const op: Opcode = @enumFromInt(@as(u4, @truncate(h[0] & 0x0f)));
            const masked = (h[1] & 0x80) != 0;
            var len: u64 = @as(u64, h[1] & 0x7f);
            if (len == 126) {
                len = std.mem.readInt(u16, try r.takeArray(2), .big);
            } else if (len == 127) {
                len = std.mem.readInt(u64, try r.takeArray(8), .big);
            }
            var mask: [4]u8 = .{ 0, 0, 0, 0 };
            if (masked) mask = (try r.takeArray(4)).*;

            switch (op) {
                .ping => {
                    const p = try r.take(@intCast(len));
                    if (masked) unmask(p, mask);
                    try self.sendFrame(.pong, p);
                    continue;
                },
                .pong => {
                    try r.discardAll(@intCast(len));
                    continue;
                },
                .close => {
                    try r.discardAll(@intCast(len));
                    self.sendFrame(.close, "") catch {};
                    return error.PeerClosed;
                },
                .text, .binary, .cont => {
                    if (out.items.len + len > message_cap) return error.MessageTooLong;
                    const start = out.items.len;
                    try out.resize(gpa, start + @as(usize, @intCast(len)));
                    try r.readSliceAll(out.items[start..]);
                    if (masked) unmask(out.items[start..], mask);
                    if (msg_op == null and op != .cont) msg_op = op;
                    if (fin) return msg_op orelse .text;
                },
                else => return error.HandshakeFailed, // unknown opcode
            }
        }
    }

    // ── internals ────────────────────────────────────────────────────────────

    fn handshake(self: *WsClient, u: Url) Error!void {
        var key_raw: [16]u8 = undefined;
        self.io.random(&key_raw);
        var key_b64: [24]u8 = undefined;
        _ = std.base64.standard.Encoder.encode(&key_b64, &key_raw);

        try self.w.print(
            "GET {s} HTTP/1.1\r\nHost: {s}:{d}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" ++
                "Sec-WebSocket-Key: {s}\r\nSec-WebSocket-Version: 13\r\n\r\n",
            .{ u.path, u.host, u.port, &key_b64 },
        );
        try self.flushTransport();

        // status line: expect "HTTP/1.1 101 ..."
        const status = try self.r.takeDelimiterInclusive('\n');
        if (std.mem.indexOf(u8, status, " 101 ") == null) return error.HandshakeFailed;
        // drain headers until the blank line
        while (true) {
            const line = try self.r.takeDelimiterInclusive('\n');
            if (line.len <= 2) break; // "\r\n" or "\n"
        }
    }

    fn flushTransport(self: *WsClient) Error!void {
        try self.w.flush(); // for TLS this encrypts plaintext into the socket writer…
        if (self.tls_client != null) try self.wr.interface.flush(); // …then push the socket buffer
    }

    fn sendFrame(self: *WsClient, op: Opcode, payload: []const u8) Error!void {
        var hdr: [14]u8 = undefined;
        hdr[0] = 0x80 | @as(u8, @intFromEnum(op)); // FIN + opcode
        var n: usize = 2;
        if (payload.len < 126) {
            hdr[1] = 0x80 | @as(u8, @intCast(payload.len));
        } else if (payload.len <= 0xffff) {
            hdr[1] = 0x80 | 126;
            std.mem.writeInt(u16, hdr[2..4], @intCast(payload.len), .big);
            n = 4;
        } else {
            hdr[1] = 0x80 | 127;
            std.mem.writeInt(u64, hdr[2..10], payload.len, .big);
            n = 10;
        }
        var mask: [4]u8 = undefined;
        self.io.random(&mask);
        @memcpy(hdr[n .. n + 4], &mask);
        n += 4;

        try self.w.writeAll(hdr[0..n]);
        var i: usize = 0;
        var tmp: [4096]u8 = undefined;
        while (i < payload.len) {
            const chunk = @min(tmp.len, payload.len - i);
            for (0..chunk) |j| tmp[j] = payload[i + j] ^ mask[(i + j) & 3];
            try self.w.writeAll(tmp[0..chunk]);
            i += chunk;
        }
        try self.flushTransport();
    }
};

fn unmask(buf: []u8, mask: [4]u8) void {
    for (buf, 0..) |*b, i| b.* ^= mask[i & 3];
}

const Url = struct { tls: bool, host: []const u8, port: u16, path: []const u8 };

fn parseUrl(url: []const u8) ?Url {
    var rest = url;
    var is_tls = false;
    if (std.mem.startsWith(u8, rest, "wss://")) {
        is_tls = true;
        rest = rest["wss://".len..];
    } else if (std.mem.startsWith(u8, rest, "ws://")) {
        rest = rest["ws://".len..];
    } else return null;

    const slash = std.mem.indexOfScalar(u8, rest, '/');
    const authority = if (slash) |s| rest[0..s] else rest;
    const path = if (slash) |s| rest[s..] else "/";
    if (authority.len == 0) return null;

    var host = authority;
    var port: u16 = if (is_tls) 443 else 80;
    if (std.mem.lastIndexOfScalar(u8, authority, ':')) |c| {
        host = authority[0..c];
        port = std.fmt.parseInt(u16, authority[c + 1 ..], 10) catch return null;
    }
    return .{ .tls = is_tls, .host = host, .port = port, .path = path };
}
