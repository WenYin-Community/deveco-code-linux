import { describe, expect, test } from "bun:test"
import { HdcProtocol } from "../../src/hdc/protocol"

describe("hdc protocol", () => {
  describe("encodeFrame", () => {
    test("prefixes a 4-byte big-endian length", () => {
      const frame = HdcProtocol.encodeFrame({ type: "exit", code: 3 })
      expect(frame.readUInt32BE(0)).toBe(frame.length - HdcProtocol.LENGTH_PREFIX_BYTES)
      expect(JSON.parse(frame.subarray(4).toString("utf-8"))).toEqual({ type: "exit", code: 3 })
    })
  })

  describe("decodeRequestFrame", () => {
    const base = {
      v: HdcProtocol.PROTOCOL_VERSION,
      token: "a".repeat(64),
      sessionID: "ses_test",
      pid: process.pid,
      caps: [...HdcProtocol.PROTOCOL_CAPS],
      cwd: "/tmp",
      argv: ["list", "targets"],
    }

    test("accepts a valid frame with optional callID", () => {
      const withoutCall = HdcProtocol.decodeRequestFrame(base)
      expect(withoutCall).toHaveProperty("value")
      const withCall = HdcProtocol.decodeRequestFrame({ ...base, callID: "call_1" })
      expect(withCall).toHaveProperty("value")
    })

    test("rejects missing or mistyped fields", () => {
      expect(HdcProtocol.decodeRequestFrame({ ...base, token: 42 })._tag).toBeDefined()
      expect(HdcProtocol.decodeRequestFrame({ ...base, sessionID: undefined })._tag).toBeDefined()
      expect(HdcProtocol.decodeRequestFrame({ ...base, pid: "self" })._tag).toBeDefined()
      expect(HdcProtocol.decodeRequestFrame({ ...base, caps: "stdin" })._tag).toBeDefined()
      expect(HdcProtocol.decodeRequestFrame("not an object")._tag).toBeDefined()
    })
  })

  describe("decodeServerFrame", () => {
    test("round-trips every frame type", () => {
      const frames: HdcProtocol.ServerFrame[] = [
        { type: "stdout", data: Buffer.from("hello").toString("base64") },
        { type: "stderr", data: Buffer.from("oops").toString("base64") },
        { type: "exit", code: 0 },
        { type: "denied", reasonCode: "approval_denied", message: "no" },
      ]
      for (const frame of frames) {
        const decoded = HdcProtocol.decodeServerFrame(JSON.parse(JSON.stringify(frame)))
        expect(decoded).toHaveProperty("value")
      }
    })

    test("rejects unknown frame types and reason codes", () => {
      expect(HdcProtocol.decodeServerFrame({ type: "explosions" })._tag).toBeDefined()
      expect(HdcProtocol.decodeServerFrame({ type: "denied", reasonCode: "made_up_code", message: "x" })._tag).toBeDefined()
      expect(HdcProtocol.decodeServerFrame({ type: "exit" })._tag).toBeDefined()
    })
  })
})
