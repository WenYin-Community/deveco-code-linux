import { describe, expect, test } from "bun:test"
import net from "node:net"
import { HdcIpcServer } from "../../src/hdc/ipc-server"
import { HdcProtocol } from "../../src/hdc/protocol"

// ─── Test client: one request per connection, collect frames ──

interface ClientResult {
  frames: HdcProtocol.ServerFrame[]
  exitCode?: number
  denial?: { reasonCode: string; message: string }
}

async function requestOnce(endpoint: string, token: string, argv: string[], options?: { sessionID?: string; cwd?: string; pid?: number; caps?: string[]; v?: number; sendRequest?: boolean }): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint)
    const result: ClientResult = { frames: [] }
    let buffer = Buffer.alloc(0)
    socket.on("error", reject)
    socket.on("connect", () => {
      // The busy rejection fires on accept, before any request frame
      // is read; a probe that stays silent still gets the denied
      // frame, without racing the server's post-flush destroy().
      if (options?.sendRequest === false) return
      const frame: HdcProtocol.RequestFrame = {
        v: options?.v ?? HdcProtocol.PROTOCOL_VERSION,
        token,
        sessionID: options?.sessionID ?? "ses_test",
        pid: options?.pid ?? process.pid,
        caps: options?.caps ?? [...HdcProtocol.PROTOCOL_CAPS],
        cwd: options?.cwd ?? process.cwd(),
        argv,
      }
      socket.write(HdcProtocol.encodeFrame(frame))
    })
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= HdcProtocol.LENGTH_PREFIX_BYTES) {
        const frameLength = buffer.readUInt32BE(0)
        if (buffer.length < HdcProtocol.LENGTH_PREFIX_BYTES + frameLength) return
        const body = buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES, HdcProtocol.LENGTH_PREFIX_BYTES + frameLength)
        buffer = buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES + frameLength)
        const decoded = HdcProtocol.decodeServerFrame(JSON.parse(body.toString("utf-8")))
        if (!decoded || !("value" in decoded)) {
          reject(new Error("server sent an invalid frame"))
          return
        }
        const frame = decoded.value
        result.frames.push(frame)
        if (frame.type === "exit") {
          result.exitCode = frame.code
          socket.end()
          resolve(result)
          return
        }
        if (frame.type === "denied") {
          result.denial = { reasonCode: frame.reasonCode, message: frame.message }
          socket.end()
          resolve(result)
          return
        }
      }
    })
    socket.on("close", () => {
      if (result.exitCode === undefined && !result.denial) reject(new Error("connection closed before a terminal frame"))
    })
  })
}

describe("hdc ipc server", () => {
  test("streams stdout/stderr and exit code for an allowed request", async () => {
    const server = await HdcIpcServer.startHdcIpcServer((ctx) => {
      ctx.emitStdout(Buffer.from("out chunk 1"))
      ctx.emitStderr(Buffer.from("err chunk"))
      ctx.emitStdout(Buffer.from("out chunk 2"))
      return Promise.resolve(7)
    })
    try {
      const result = await requestOnce(server.endpoint, server.token, ["list", "targets"])
      expect(result.exitCode).toBe(7)
      expect(result.frames.map((f) => f.type)).toEqual(["stdout", "stderr", "stdout", "exit"])
      expect(Buffer.from((result.frames[0] as { data: string }).data, "base64").toString()).toBe("out chunk 1")
      expect(Buffer.from((result.frames[1] as { data: string }).data, "base64").toString()).toBe("err chunk")
    } finally {
      await server.close()
    }
  })

  test("denies a wrong token (guard_unavailable, never passthrough)", async () => {
    const server = await HdcIpcServer.startHdcIpcServer(() => Promise.resolve(0))
    try {
      const result = await requestOnce(server.endpoint, "0".repeat(64), ["list", "targets"])
      expect(result.denial?.reasonCode).toBe("guard_unavailable")
      expect(result.denial?.message).toBe("unauthorized")
    } finally {
      await server.close()
    }
  })

  test("denies a mismatched protocol version", async () => {
    const server = await HdcIpcServer.startHdcIpcServer(() => Promise.resolve(0))
    try {
      const result = await requestOnce(server.endpoint, server.token, ["list", "targets"], { v: 2 })
      expect(result.denial?.reasonCode).toBe("protocol_incompatible")
      expect(result.denial?.message).toContain(`server requires ${HdcProtocol.PROTOCOL_VERSION}`)
    } finally {
      await server.close()
    }
  })

  test("denies a request declaring an unsupported capability", async () => {
    const server = await HdcIpcServer.startHdcIpcServer(() => Promise.resolve(0))
    try {
      const result = await requestOnce(server.endpoint, server.token, ["list", "targets"], { caps: ["telekinesis"] })
      expect(result.denial?.reasonCode).toBe("capability_unsupported")
      expect(result.denial?.message).toContain("telekinesis")
    } finally {
      await server.close()
    }
  })

  test("denies a request whose peer pid is not probeable", async () => {
    const server = await HdcIpcServer.startHdcIpcServer(() => Promise.resolve(0))
    try {
      const ghost = await requestOnce(server.endpoint, server.token, ["list", "targets"], { pid: 999999999 })
      expect(ghost.denial?.reasonCode).toBe("protocol_incompatible")
      expect(ghost.denial?.message).toContain("peer process not found")
      const invalid = await requestOnce(server.endpoint, server.token, ["list", "targets"], { pid: 0 })
      expect(invalid.denial?.reasonCode).toBe("protocol_incompatible")
      expect(invalid.denial?.message).toContain("peer process not found")
    } finally {
      await server.close()
    }
  })


  test("wraps handler rejections as guard_unavailable and HdcDenial as its own reason", async () => {
    const { HdcDenial } = await import("../../src/hdc/reason")
    const server = await HdcIpcServer.startHdcIpcServer(() => Promise.reject(new Error("boom")))
    try {
      const result = await requestOnce(server.endpoint, server.token, ["list", "targets"])
      expect(result.denial?.reasonCode).toBe("guard_unavailable")
      expect(result.denial?.message).toContain("boom")
    } finally {
      await server.close()
    }

    const denied = await HdcIpcServer.startHdcIpcServer(() => Promise.reject(new HdcDenial("approval_denied", "nope")))
    try {
      const result = await requestOnce(denied.endpoint, denied.token, ["list", "targets"])
      expect(result.denial?.reasonCode).toBe("approval_denied")
      expect(result.denial?.message).toBe("nope")
    } finally {
      await denied.close()
    }
  })

  test("rejects malformed JSON and schema-invalid frames", async () => {
    const server = await HdcIpcServer.startHdcIpcServer(() => Promise.resolve(0))
    try {
      const badJson = await new Promise<ClientResult>((resolve, reject) => {
        const socket = net.createConnection(server.endpoint)
        const result: ClientResult = { frames: [] }
        socket.on("error", reject)
        socket.on("connect", () => {
          const body = Buffer.from("{not json")
          const header = Buffer.alloc(4)
          header.writeUInt32BE(body.length, 0)
          socket.write(Buffer.concat([header, body]))
        })
        socket.on("data", (chunk: Buffer) => {
          const decoded = HdcProtocol.decodeServerFrame(JSON.parse(chunk.subarray(4).toString("utf-8")))
          if (decoded && "value" in decoded) {
            const frame = decoded.value
            if (frame.type === "denied") {
              result.denial = { reasonCode: frame.reasonCode, message: frame.message }
              socket.end()
              resolve(result)
            }
          }
        })
      })
      expect(badJson.denial?.reasonCode).toBe("guard_unavailable")

      const badSchema = await new Promise<ClientResult>((resolve, reject) => {
        const socket = net.createConnection(server.endpoint)
        const result: ClientResult = { frames: [] }
        socket.on("error", reject)
        socket.on("connect", () => {
          const body = Buffer.from(JSON.stringify({ hello: "world" }))
          const header = Buffer.alloc(4)
          header.writeUInt32BE(body.length, 0)
          socket.write(Buffer.concat([header, body]))
        })
        socket.on("data", (chunk: Buffer) => {
          const decoded = HdcProtocol.decodeServerFrame(JSON.parse(chunk.subarray(4).toString("utf-8")))
          if (decoded && "value" in decoded) {
            const frame = decoded.value
            if (frame.type === "denied") {
              result.denial = { reasonCode: frame.reasonCode, message: frame.message }
              socket.end()
              resolve(result)
            }
          }
        })
      })
      expect(badSchema.denial?.reasonCode).toBe("guard_unavailable")
    } finally {
      await server.close()
    }
  })

  test("aborts the handler when the client disconnects mid-request", async () => {
    let aborted = false
    const server = await HdcIpcServer.startHdcIpcServer(
      (ctx) =>
        new Promise<number>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true
            resolve(1)
          })
        }),
    )
    try {
      const socket = net.createConnection(server.endpoint)
      await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
      socket.write(
        HdcProtocol.encodeFrame({
          v: HdcProtocol.PROTOCOL_VERSION,
          token: server.token,
          sessionID: "ses_test",
          pid: process.pid,
          caps: [...HdcProtocol.PROTOCOL_CAPS],
          cwd: process.cwd(),
          argv: ["list", "targets"],
        }),
      )
      socket.destroy()
      await new Promise<void>((resolve) => {
        const start = Date.now()
        const poll = () => {
          if (aborted || Date.now() - start > 2000) return resolve()
          setTimeout(poll, 10)
        }
        poll()
      })
      expect(aborted).toBe(true)
    } finally {
      await server.close()
    }
  })

  test("fails closed with server busy beyond the concurrency limit", async () => {
    const waiting: (() => void)[] = []
    const server = await HdcIpcServer.startHdcIpcServer(
      () =>
        new Promise<number>((resolve) => {
          waiting.push(() => resolve(0))
        }),
    )
    try {
      const held: Promise<ClientResult>[] = []
      for (let i = 0; i < HdcProtocol.MAX_CONCURRENT_REQUESTS; i++) {
        held.push(requestOnce(server.endpoint, server.token, ["list", "targets"]))
      }
      // Wait until every held request is actually running on the
      // server (published readiness, not a fixed sleep).
      const deadline = Date.now() + 10_000
      while (waiting.length < HdcProtocol.MAX_CONCURRENT_REQUESTS && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(waiting).toHaveLength(HdcProtocol.MAX_CONCURRENT_REQUESTS)

      // Diagnose a stalled busy reply in 5s instead of the 30s test
      // timeout — the denied frame must arrive promptly. The probe
      // connects without sending: the server rejects busy connections
      // on accept, and a concurrent request write can race the
      // server's post-flush destroy() into EPIPE on a loaded host.
      let busyTimeout: ReturnType<typeof setTimeout> | undefined
      const busy = await Promise.race([
        requestOnce(server.endpoint, server.token, ["list", "targets"], { sendRequest: false }),
        new Promise<never>((_, reject) => {
          busyTimeout = setTimeout(() => reject(new Error("busy request was not answered within 5s")), 5_000)
        }),
      ])
      clearTimeout(busyTimeout)
      expect(busy.denial?.reasonCode).toBe("guard_unavailable")
      expect(busy.denial?.message).toBe("server busy")

      for (const release of waiting) release()
      const results = await Promise.all(held)
      expect(results.every((r) => r.exitCode === 0)).toBe(true)
    } finally {
      // Release anything still held: server.close() waits for all
      // connections to end, and never-resolving handlers would
      // otherwise hang the test until the 30s timeout.
      for (const release of waiting) release()
      await server.close()
    }
  })

  test("forwards stdin frames and stdinEnd to the attached consumer", async () => {
    const stdinChunks: string[] = []
    let stdinEnded = false
    const server = await HdcIpcServer.startHdcIpcServer((ctx) => {
      ctx.attachStdin({
        onStdin: (chunk) => stdinChunks.push(chunk.toString("utf8")),
        onStdinEnd: () => {
          stdinEnded = true
        },
      })
      return Promise.resolve(0)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(server.endpoint)
        socket.on("error", reject)
        socket.on("connect", () => {
          socket.write(
            HdcProtocol.encodeFrame({
              v: HdcProtocol.PROTOCOL_VERSION,
              token: server.token,
              sessionID: "ses_test",
              pid: process.pid,
              caps: [...HdcProtocol.PROTOCOL_CAPS],
              cwd: process.cwd(),
              argv: ["shell"],
            }),
          )
          // stdin frames may be sent right after the request.
          socket.write(HdcProtocol.encodeFrame({ type: "stdin", data: Buffer.from("hello").toString("base64") }))
          socket.write(HdcProtocol.encodeFrame({ type: "stdin", data: Buffer.from(" world").toString("base64") }))
          socket.write(HdcProtocol.encodeFrame({ type: "stdinEnd" }))
        })
        socket.on("data", () => {
          // Drain until the server finishes (exit frame observed).
          // The handler resolves immediately, so wait a tick and check.
        })
        socket.on("close", resolve)
      })
      expect(stdinChunks.join("")).toBe("hello world")
      expect(stdinEnded).toBe(true)
    } finally {
      await server.close()
    }
  })

  test("replays stdin frames that arrive before attachStdin", async () => {
    const stdinChunks: string[] = []
    let stdinEnded = false
    const server = await HdcIpcServer.startHdcIpcServer((ctx) => {
      // Attach asynchronously, simulating a handler that starts its
      // execution path after the client has already sent stdin.
      setTimeout(() => {
        ctx.attachStdin({
          onStdin: (chunk) => stdinChunks.push(chunk.toString("utf8")),
          onStdinEnd: () => {
            stdinEnded = true
          },
        })
      }, 50)
      return new Promise<number>((resolve) => setTimeout(() => resolve(0), 200))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(server.endpoint)
        let buffer = Buffer.alloc(0)
        let sawExit = false
        socket.on("error", reject)
        socket.on("connect", () => {
          socket.write(
            HdcProtocol.encodeFrame({
              v: HdcProtocol.PROTOCOL_VERSION,
              token: server.token,
              sessionID: "ses_test",
              pid: process.pid,
              caps: [...HdcProtocol.PROTOCOL_CAPS],
              cwd: process.cwd(),
              argv: ["shell"],
            }),
          )
          socket.write(HdcProtocol.encodeFrame({ type: "stdin", data: Buffer.from("early").toString("base64") }))
          socket.write(HdcProtocol.encodeFrame({ type: "stdinEnd" }))
        })
        socket.on("data", (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk])
          while (buffer.length >= HdcProtocol.LENGTH_PREFIX_BYTES) {
            const frameLength = buffer.readUInt32BE(0)
            if (buffer.length < HdcProtocol.LENGTH_PREFIX_BYTES + frameLength) return
            const body = buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES, HdcProtocol.LENGTH_PREFIX_BYTES + frameLength)
            buffer = buffer.subarray(HdcProtocol.LENGTH_PREFIX_BYTES + frameLength)
            const decoded = HdcProtocol.decodeServerFrame(JSON.parse(body.toString("utf-8")))
            if (decoded && "value" in decoded && decoded.value.type === "exit") {
              sawExit = true
              socket.end()
              resolve()
              return
            }
          }
        })
        socket.on("close", () => {
          if (!sawExit) reject(new Error("connection closed before an exit frame"))
        })
      })
      expect(stdinChunks.join("")).toBe("early")
      expect(stdinEnded).toBe(true)
    } finally {
      await server.close()
    }
  })
})
