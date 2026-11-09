export * as HdcShim from "./shim"

import net from "node:net"
import { Option } from "effect"
import { HdcProtocol } from "./protocol"
import { HdcReason } from "./reason"

// ─── HDC shim client (SR1) ──────────────────────────────────
// Entered via `deveco __hdc-shim -- <argv>` from the `hdc`
// shim script in Global.Path.bin. Connects to this process's
// guard IPC server, forwards the argv, streams output, and
// mirrors the exit code.
//
// Fail closed: missing guard env, unreachable server, or any
// protocol violation prints a denial and exits 1. The real hdc
// is never invoked directly.

export function printDenial(reasonCode: HdcReason.ReasonCode, message: string) {
  process.stderr.write(`[hdc-guard] reason_code=${reasonCode} message=${message}\n`)
}

function guardEnv() {
  return {
    endpoint: process.env.DEVECO_CODE_HDC_ENDPOINT,
    token: process.env.DEVECO_CODE_HDC_TOKEN,
    sessionID: process.env.DEVECO_CODE_HDC_SESSION,
    callID: process.env.DEVECO_CODE_HDC_CALL,
  }
}

interface ShimConnection {
  token: string
  sessionID: string
  callID: string | undefined
  argv: string[]
}

export async function runHdcShim(argv: string[]): Promise<number> {
  const env = guardEnv()
  if (!env.endpoint || !env.token || !env.sessionID) {
    printDenial("guard_unavailable", "hdc shim invoked outside a guarded deveco shell; refusing to run (fail closed)")
    return 1
  }

  const socket = net.createConnection(env.endpoint)
  let cancelled = false
  const onSignal = () => {
    cancelled = true
    // Destroying the socket makes the server abort the in-flight
    // request (socket close = cancel) and kill the spawned hdc.
    socket.destroy()
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  try {
    return await exchange(socket, {
      token: env.token,
      sessionID: env.sessionID,
      callID: env.callID,
      argv,
    }, () => cancelled)
  } catch (error) {
    printDenial("guard_unavailable", `unable to reach hdc guard: ${errorMessage(error)}`)
    return 1
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    socket.destroy()
  }
}

// Runs one request/response exchange over the guard socket and resolves
// with the remote exit code.
function exchange(socket: net.Socket, connection: ShimConnection, isCancelled: () => boolean): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const reader: ResponseReader = { buffer: Buffer.alloc(0) }

    socket.on("error", (error) => reject(error))

    socket.on("connect", () => {
      socket.write(HdcProtocol.encodeFrame(buildRequest(connection)))
      forwardStdin(socket)
    })

    socket.on("data", (chunk: Buffer) => {
      const outcome = readFrames(reader, chunk)
      if (outcome._tag === "continue") return
      if (outcome._tag === "fail") {
        reject(outcome.error)
        return
      }
      resolve(outcome.code)
    })

    socket.on("close", () => {
      if (isCancelled()) {
        printDenial("cancelled", "client disconnected before completion")
        resolve(1)
        return
      }
      reject(new Error("connection closed by guard server"))
    })
  })
}

function buildRequest(connection: ShimConnection): HdcProtocol.RequestFrame {
  return {
    v: HdcProtocol.PROTOCOL_VERSION,
    token: connection.token,
    sessionID: connection.sessionID,
    callID: connection.callID,
    pid: process.pid,
    caps: [...HdcProtocol.PROTOCOL_CAPS],
    cwd: process.cwd(),
    argv: connection.argv,
  }
}

// Forward the client's stdin to the guard as stdin frames so
// interactive/piped hdc commands (`hdc shell`) get input. EOF
// sends a final stdinEnd frame.
function forwardStdin(sock: net.Socket) {
  const sendChunk = (chunk: Buffer) => {
    if (sock.destroyed) return
    sock.write(HdcProtocol.encodeFrame({ type: "stdin", data: chunk.toString("base64") }))
  }
  process.stdin.on("data", sendChunk)
  process.stdin.on("end", () => {
    if (sock.destroyed) return
    sock.write(HdcProtocol.encodeFrame({ type: "stdinEnd" }))
  })
}

interface ResponseReader {
  buffer: Buffer
}

type FrameOutcome = { _tag: "continue" } | { _tag: "exit"; code: number } | { _tag: "fail"; error: Error }

function readFrames(reader: ResponseReader, chunk: Buffer): FrameOutcome {
  reader.buffer = Buffer.concat([reader.buffer, chunk])
  while (reader.buffer.length >= HdcProtocol.LENGTH_PREFIX_BYTES) {
    const outcome = readOneFrame(reader)
    if (outcome._tag !== "continue") return outcome
  }
  return { _tag: "continue" }
}

function readOneFrame(reader: ResponseReader): FrameOutcome {
  const frameLength = reader.buffer.readUInt32BE(0)
  if (frameLength > HdcProtocol.MAX_FRAME_BYTES) {
    return { _tag: "fail", error: new Error("response frame exceeds size limit") }
  }
  const total = HdcProtocol.LENGTH_PREFIX_BYTES + frameLength
  if (reader.buffer.length < total) return { _tag: "continue" }

  const body = reader.buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES, total)
  reader.buffer = reader.buffer.subarray(total)

  const decoded = decodeJson(body)
  if (!decoded.ok) return { _tag: "fail", error: new Error("response frame is not valid JSON") }

  const frame = HdcProtocol.decodeServerFrame(decoded.value)
  if (Option.isNone(frame)) {
    return { _tag: "fail", error: new Error("response frame failed schema validation") }
  }
  return handleFrame(frame.value)
}

function decodeJson(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body.toString("utf-8")) }
  } catch {
    return { ok: false }
  }
}

function handleFrame(frame: HdcProtocol.ServerFrame): FrameOutcome {
  if (frame.type === "stdout") {
    process.stdout.write(Buffer.from(frame.data, "base64"))
    return { _tag: "continue" }
  }
  if (frame.type === "stderr") {
    process.stderr.write(Buffer.from(frame.data, "base64"))
    return { _tag: "continue" }
  }
  if (frame.type === "exit") return { _tag: "exit", code: frame.code }
  printDenial(frame.reasonCode, frame.message)
  return { _tag: "exit", code: 1 }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
