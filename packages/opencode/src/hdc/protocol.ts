export * as HdcProtocol from "./protocol"

import { Schema } from "effect"
import { HdcReason } from "./reason"

// ─── HDC guard IPC protocol (SR1) ───────────────────────────
// One request per connection. Wire format: 4-byte big-endian length
// prefix + UTF-8 JSON frame. Binary payloads are embedded as base64
// strings. The transport is UDS (unix) or a Named Pipe (windows) —
// never localhost TCP.

export const PROTOCOL_VERSION = 3

export const LENGTH_PREFIX_BYTES = 4
export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_CONCURRENT_REQUESTS = 16
export const MAX_STREAM_BUFFER_BYTES = 1024 * 1024

// Capabilities a shim may require (AR-SEC1-002 §2). The server
// denies requests that declare a capability it does not support
// (`capability_unsupported`), so a newer shim can never half-run
// against an older server.
export const PROTOCOL_CAPS = ["stdin", "stream"] as const
export type ProtocolCap = (typeof PROTOCOL_CAPS)[number]

// ─── Request frame (client -> server) ───────────────────────
// `token` is the per-process 256-bit hex secret; mismatch = deny.
// `sessionID`/`cwd`/`argv` are advisory context validated by the
// server against its session registry; env-supplied values are
// never trusted on their own.
// `pid` is the shim's own OS process id; the server probes that it
// names a live process in the current user session (OS peer check).
// `caps` are the capabilities the shim requires (see PROTOCOL_CAPS).

export const RequestFrame = Schema.Struct({
  v: Schema.Number,
  token: Schema.String,
  sessionID: Schema.String,
  callID: Schema.String.pipe(Schema.optional),
  pid: Schema.Number,
  caps: Schema.mutable(Schema.Array(Schema.String)),
  cwd: Schema.String,
  argv: Schema.mutable(Schema.Array(Schema.String)),
}).annotate({
  identifier: "HdcProtocol.RequestFrame",
  description: "Single hdc invocation request sent from the shim to the guard server",
})
export type RequestFrame = typeof RequestFrame.Type

// ─── Client frames (client -> server, after the request) ────
// The request opens the stream; `stdin`/`stdinEnd` frames forward
// the client's process stdin to the spawned hdc (interactive
// `hdc shell` sessions and piped input). Data is base64-encoded.

export const StdinFrame = Schema.Struct({
  type: Schema.Literals(["stdin"]),
  data: Schema.String,
})
export const StdinEndFrame = Schema.Struct({
  type: Schema.Literals(["stdinEnd"]),
})
export const ClientFrame = Schema.Union([RequestFrame, StdinFrame, StdinEndFrame])
export type ClientFrame = typeof ClientFrame.Type

export const decodeClientFrame = Schema.decodeUnknownOption(ClientFrame)

// ─── Server frames (server -> client) ───────────────────────
// stdout/stderr chunks carry base64-encoded bytes. `denied` is sent
// instead of running the command; `exit` ends the stream.

export const ServerFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["stdout"]),
    data: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["stderr"]),
    data: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["exit"]),
    code: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literals(["denied"]),
    reasonCode: Schema.Literals(HdcReason.REASON_CODES),
    message: Schema.String,
  }),
]).annotate({
  identifier: "HdcProtocol.ServerFrame",
  description: "Streamed response frames from the guard server to the shim",
})
export type ServerFrame = typeof ServerFrame.Type

export const decodeRequestFrame = Schema.decodeUnknownOption(RequestFrame)
export const decodeServerFrame = Schema.decodeUnknownOption(ServerFrame)

// ─── Frame encoding helpers ─────────────────────────────────

export function encodeFrame(frame: ServerFrame | ClientFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf-8")
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}
