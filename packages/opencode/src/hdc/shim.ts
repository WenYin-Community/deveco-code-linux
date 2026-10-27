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

export async function runHdcShim(argv: string[]): Promise<number> {
  const { endpoint, token, sessionID, callID } = guardEnv()
  if (!endpoint || !token || !sessionID) {
    printDenial("guard_unavailable", "hdc shim invoked outside a guarded deveco shell; refusing to run (fail closed)")
    return 1
  }

  const socket = net.createConnection(endpoint)

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
    const code = await new Promise<number>((resolve, reject) => {
      socket.on("error", (error) => reject(error))

      socket.on("connect", () => {
        const request: HdcProtocol.RequestFrame = {
          v: HdcProtocol.PROTOCOL_VERSION,
          token,
          sessionID,
          callID,
          pid: process.pid,
          caps: [...HdcProtocol.PROTOCOL_CAPS],
          cwd: process.cwd(),
          argv,
        }
        socket.write(HdcProtocol.encodeFrame(request))
        forwardStdin(socket)
      })

      // Forward the client's stdin to the guard as stdin frames so
      // interactive/piped hdc commands (`hdc shell`) get input. EOF
      // sends a final stdinEnd frame.
      const forwardStdin = (sock: net.Socket) => {
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

      let buffer = Buffer.alloc(0)
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= HdcProtocol.LENGTH_PREFIX_BYTES) {
          const frameLength = buffer.readUInt32BE(0)
          if (frameLength > HdcProtocol.MAX_FRAME_BYTES) {
            reject(new Error("response frame exceeds size limit"))
            return
          }
          if (buffer.length < HdcProtocol.LENGTH_PREFIX_BYTES + frameLength) return
          const body = buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES, HdcProtocol.LENGTH_PREFIX_BYTES + frameLength)
          buffer = buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES + frameLength)

          let parsed: unknown
          try {
            parsed = JSON.parse(body.toString("utf-8"))
          } catch {
            reject(new Error("response frame is not valid JSON"))
            return
          }
          const frame = HdcProtocol.decodeServerFrame(parsed)
          if (Option.isNone(frame)) {
            reject(new Error("response frame failed schema validation"))
            return
          }
          if (frame.value.type === "stdout") {
            process.stdout.write(Buffer.from(frame.value.data, "base64"))
            continue
          }
          if (frame.value.type === "stderr") {
            process.stderr.write(Buffer.from(frame.value.data, "base64"))
            continue
          }
          if (frame.value.type === "exit") {
            resolve(frame.value.code)
            return
          }
          printDenial(frame.value.reasonCode, frame.value.message)
          resolve(1)
          return
        }
      })

      socket.on("close", () => {
        if (cancelled) {
          printDenial("cancelled", "client disconnected before completion")
          resolve(1)
          return
        }
        reject(new Error("connection closed by guard server"))
      })
    })
    return code
  } catch (error) {
    printDenial("guard_unavailable", `unable to reach hdc guard: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    socket.destroy()
  }
}
