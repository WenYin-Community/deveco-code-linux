export * as HdcIpcServer from "./ipc-server"

import crypto from "node:crypto"
import { unlink } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Option } from "effect"
import { HdcProtocol } from "./protocol"
import { HdcDenial, HdcReason } from "./reason"

// ─── HDC guard IPC server (SR1) ─────────────────────────────
// Per-process UDS (unix) / Named Pipe (windows) server. One
// request per connection. Never localhost TCP.
//
// Fail closed everywhere: token mismatch, undecodable frames,
// over-limit concurrency, and handler crashes all become
// `denied` frames — never a passthrough.

export interface HdcRequestContext {
  request: HdcProtocol.RequestFrame
  emitStdout: (chunk: Buffer) => void
  emitStderr: (chunk: Buffer) => void
  // stdin forwarding: after this returns, the handler owns the
  // stdin stream. Any stdin frames buffered before the handler
  // attached are replayed immediately (in order) via the consumer.
  attachStdin: (consumer: { onStdin: (chunk: Buffer) => void; onStdinEnd: () => void }) => void
  // Fired when the client disconnects mid-request; handlers must
  // cancel execution (kill the spawned hdc) in response.
  signal: AbortSignal
}

// Resolves with the hdc exit code; rejects with HdcDenial for
// guard rejections. Any other rejection is treated as
// guard_unavailable (fail closed).
export type HdcRequestHandler = (ctx: HdcRequestContext) => Promise<number>

export interface HdcIpcServer {
  endpoint: string
  token: string
  close(): Promise<void>
}

export function generateEndpoint(): string {
  const suffix = `${process.pid}-${crypto.randomBytes(2).toString("hex")}`
  if (process.platform === "win32") return `\\\\.\\pipe\\deveco-hdc-${suffix}`
  return path.join(os.tmpdir(), `deveco-hdc-${suffix}.sock`)
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex")
}

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8")
  const bufB = Buffer.from(b, "utf-8")
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

// OS peer check: signal 0 probes that a process with this pid is
// alive AND reachable from the guard (same user or privileged).
// ESRCH = no such process, EPERM/EACCES = cross-user process.
// Both mean the peer identity is not verifiable — fail closed.
function isProbeablePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ─── Per-connection state machine ───────────────────────────
// Reads one request frame, then any number of stdin frames, then
// streams server frames back. A second request frame on the same
// connection is a protocol violation. stdin frames arriving before
// the handler attaches a consumer are buffered (in order) and
// replayed on attach.

type StdinFrameRead =
  | { kind: "incomplete" }
  | { kind: "denied"; message: string }
  | { kind: "frame"; value: HdcProtocol.ClientFrame }

type StdinStep = { kind: "wait" } | { kind: "ok" } | { kind: "denied"; message: string }

class Connection {
  private buffer = Buffer.alloc(0)
  private requestSeen = false
  private finished = false
  private controller = new AbortController()
  private active = false
  private stdinConsumer: { onStdin: (chunk: Buffer) => void; onStdinEnd: () => void } | undefined
  private pendingStdin: Buffer[] = []
  private pendingStdinEnd = false
  private stdinClosed = false

  constructor(
    private socket: net.Socket,
    private token: string,
    private handler: HdcRequestHandler,
    private onActiveChange: (delta: number) => void,
  ) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk))
    socket.on("error", () => this.controller.abort())
    socket.on("close", () => this.controller.abort())
  }

  private send(frame: HdcProtocol.ServerFrame) {
    if (this.socket.destroyed) return
    // Backpressure: if the client is not draining, cancel the
    // execution instead of buffering without bound.
    if (this.socket.writableLength > HdcProtocol.MAX_STREAM_BUFFER_BYTES) {
      this.controller.abort()
      return
    }
    this.socket.write(HdcProtocol.encodeFrame(frame))
  }

  private sendDenied(reasonCode: HdcReason.ReasonCode, message: string) {
    this.send({ type: "denied", reasonCode, message })
    this.finish()
  }

  private finish() {
    if (this.finished) return
    this.finished = true
    if (this.active) this.onActiveChange(-1)
    this.socket.end()
  }

  private onData(chunk: Buffer) {
    if (this.finished) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.requestSeen) {
      this.tryReadRequest()
      return
    }
    this.tryReadStdinFrames()
  }

  private tryReadRequest() {
    if (this.buffer.length < HdcProtocol.LENGTH_PREFIX_BYTES) return

    const frameLength = this.buffer.readUInt32BE(0)
    if (frameLength > HdcProtocol.MAX_FRAME_BYTES) {
      this.requestSeen = true
      this.sendDenied("guard_unavailable", "request frame exceeds size limit")
      return
    }
    if (this.buffer.length < HdcProtocol.LENGTH_PREFIX_BYTES + frameLength) return

    this.requestSeen = true
    const body = this.buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES, HdcProtocol.LENGTH_PREFIX_BYTES + frameLength)
    this.buffer = this.buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES + frameLength)
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString("utf-8"))
    } catch {
      this.sendDenied("guard_unavailable", "request frame is not valid JSON")
      return
    }
    const request = HdcProtocol.decodeRequestFrame(parsed)
    if (Option.isNone(request)) {
      this.sendDenied("guard_unavailable", "request frame failed schema validation")
      return
    }
    void this.run(request.value)
    // Frames may have arrived in the same packet as the request.
    this.tryReadStdinFrames()
  }

  private attachStdin(consumer: { onStdin: (chunk: Buffer) => void; onStdinEnd: () => void }) {
    if (this.stdinConsumer || this.finished) {
      // Late attach after the request finished (or a duplicate): the
      // consumer will never receive data; close its stream immediately.
      consumer.onStdinEnd()
      return
    }
    this.stdinConsumer = consumer
    for (const chunk of this.pendingStdin) consumer.onStdin(chunk)
    this.pendingStdin = []
    if (this.pendingStdinEnd) {
      this.pendingStdinEnd = false
      consumer.onStdinEnd()
    }
  }

  // Frames after the request are stdin data: decode each as a
  // ClientFrame and forward to the handler in order. Anything
  // undecodable is a protocol violation (fail closed).
  private tryReadStdinFrames() {
    if (this.finished || !this.requestSeen) return
    for (;;) {
      if (this.buffer.length < HdcProtocol.LENGTH_PREFIX_BYTES) return
      const step = this.consumeStdinFrame()
      if (step.kind === "wait") return
      if (step.kind === "denied") {
        this.sendDenied("guard_unavailable", step.message)
        return
      }
    }
  }

  // Decodes and applies exactly one stdin frame. "wait" means the
  // buffer holds a partial frame, so reading stops until more data
  // arrives.
  private consumeStdinFrame(): StdinStep {
    const read = this.readStdinFrame()
    if (read.kind === "incomplete") return { kind: "wait" }
    if (read.kind === "denied") return { kind: "denied", message: read.message }
    if (this.applyStdinFrame(read.value)) return { kind: "ok" }
    // A second request frame on the same connection.
    return { kind: "denied", message: "multiple requests on one connection" }
  }

  private readStdinFrame(): StdinFrameRead {
    const frameLength = this.buffer.readUInt32BE(0)
    if (frameLength > HdcProtocol.MAX_FRAME_BYTES) return { kind: "denied", message: "stdin frame exceeds size limit" }
    if (this.buffer.length < HdcProtocol.LENGTH_PREFIX_BYTES + frameLength) return { kind: "incomplete" }

    const body = this.buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES, HdcProtocol.LENGTH_PREFIX_BYTES + frameLength)
    this.buffer = this.buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES + frameLength)
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString("utf-8"))
    } catch {
      return { kind: "denied", message: "stdin frame is not valid JSON" }
    }
    const frame = HdcProtocol.decodeClientFrame(parsed)
    if (Option.isNone(frame)) return { kind: "denied", message: "stdin frame failed schema validation" }
    return { kind: "frame", value: frame.value }
  }

  // Returns false when the frame is a protocol violation (a request
  // frame after the first one).
  private applyStdinFrame(value: HdcProtocol.ClientFrame): boolean {
    if (!("type" in value)) return false
    if (value.type === "stdin") {
      if (this.stdinClosed) return true
      this.deliverStdin(Buffer.from(value.data, "base64"))
      return true
    }
    if (value.type !== "stdinEnd") return false
    if (this.stdinClosed) return true
    this.stdinClosed = true
    this.deliverStdinEnd()
    return true
  }

  private deliverStdin(chunk: Buffer) {
    if (this.stdinConsumer) this.stdinConsumer.onStdin(chunk)
    else this.pendingStdin.push(chunk)
  }

  private deliverStdinEnd() {
    if (this.stdinConsumer) this.stdinConsumer.onStdinEnd()
    else this.pendingStdinEnd = true
  }

  private async run(request: HdcProtocol.RequestFrame): Promise<void> {
    // Version negotiation (AR-SEC1-002 §1): a shim built against a
    // different protocol version is never half-served.
    if (request.v !== HdcProtocol.PROTOCOL_VERSION) {
      this.sendDenied("protocol_incompatible", `unsupported protocol version: got ${request.v}, server requires ${HdcProtocol.PROTOCOL_VERSION}`)
      return
    }

    // Capability negotiation (AR-SEC1-002 §2): every capability the
    // shim requires must be one the server actually implements.
    for (const cap of request.caps) {
      if (!HdcProtocol.PROTOCOL_CAPS.includes(cap as HdcProtocol.ProtocolCap)) {
        this.sendDenied("capability_unsupported", `required capability not supported: ${cap}`)
        return
      }
    }

    // OS peer authentication (AR-SEC1-002 §2): the declared pid must
    // name a live process the guard can probe in this user session.
    // EPERM (cross-user) and ESRCH (no such process) both deny.
    if (!isProbeablePid(request.pid)) {
      this.sendDenied("protocol_incompatible", `peer process not found or not accessible (pid=${request.pid})`)
      return
    }

    if (!tokensMatch(request.token, this.token)) {
      this.sendDenied("guard_unavailable", "unauthorized")
      return
    }

    this.active = true
    this.onActiveChange(1)
    const stdout = (chunk: Buffer) => this.send({ type: "stdout", data: chunk.toString("base64") })
    const stderr = (chunk: Buffer) => this.send({ type: "stderr", data: chunk.toString("base64") })
    try {
      const code = await this.handler({
        request,
        emitStdout: stdout,
        emitStderr: stderr,
        attachStdin: (consumer) => this.attachStdin(consumer),
        signal: this.controller.signal,
      })
      // If the handler never attached a stdin consumer, close it now
      // so any straggler stdin frames are not silently accepted.
      if (this.stdinConsumer) {
        this.stdinConsumer.onStdinEnd()
        this.stdinConsumer = undefined
      }
      this.send({ type: "exit", code })
      this.finish()
    } catch (error) {
      const denial = error instanceof HdcDenial ? error : new HdcDenial("guard_unavailable", `internal error: ${error instanceof Error ? error.message : String(error)}`)
      this.sendDenied(denial.reasonCode, denial.message)
    } finally {
      this.stdinConsumer = undefined
    }
  }
}

// ─── Server lifecycle ───────────────────────────────────────

export function startHdcIpcServer(handler: HdcRequestHandler): Promise<HdcIpcServer> {
  const endpoint = generateEndpoint()
  const token = generateToken()
  const limiter: ConnectionLimiter = { token, handler, active: 0 }

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => acceptConnection(socket, limiter))
    server.on("error", (error) => {
      if (!listening) reject(error)
    })

    let listening = false
    server.listen(endpoint, () => {
      listening = true
      resolve({ endpoint, token, close: () => closeServer(server, endpoint) })
    })
  })
}

interface ConnectionLimiter {
  token: string
  handler: HdcRequestHandler
  active: number
}

function acceptConnection(socket: net.Socket, limiter: ConnectionLimiter): void {
  // Concurrency limit: fail closed rather than queue unboundedly.
  if (limiter.active >= HdcProtocol.MAX_CONCURRENT_REQUESTS) {
    rejectBusy(socket)
    return
  }
  socket.on("error", () => {})
  void new Connection(socket, limiter.token, limiter.handler, (delta) => {
    limiter.active += delta
  })
}

function rejectBusy(socket: net.Socket): void {
  socket.on("error", () => {})
  // end() inside the connection callback leaves server.close() hanging on Bun/Windows
  // named pipes; destroy on write-callback instead (frame is flushed to the OS first).
  socket.write(HdcProtocol.encodeFrame({ type: "denied", reasonCode: "guard_unavailable", message: "server busy" }), () =>
    socket.destroy(),
  )
}

function closeServer(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose())
    if (process.platform !== "win32") unlink(endpoint, () => {})
  })
}
