import { EventStreamCodec } from "@smithy/eventstream-codec"
import { fromUtf8, toUtf8 } from "@smithy/util-utf8"
import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { framing } from "../src/protocols/bedrock-event-stream"
import { it } from "./lib/effect"

const codec = new EventStreamCodec(toUtf8, fromUtf8)
const utf8Encoder = new TextEncoder()

// Build a single AWS event-stream frame for a Converse stream event. Each
// frame carries `:message-type=event` + `:event-type=<name>` headers and a
// JSON payload body.
const eventFrame = (type: string, payload: object) =>
  codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: type },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: utf8Encoder.encode(JSON.stringify(payload)),
  })

const concat = (frames: ReadonlyArray<Uint8Array>) => {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

const bedrockFraming = framing("bedrock-converse")

const decode = (chunks: ReadonlyArray<Uint8Array>) =>
  Stream.fromIterable(chunks).pipe(bedrockFraming.frame, Stream.runCollect)

describe("Bedrock event-stream framing", () => {
  it.effect("decodes all frames from a single chunk in order", () =>
    Effect.gen(function* () {
      const frames = yield* decode([
        concat([eventFrame("messageStart", { role: "assistant" }), eventFrame("messageStop", { stopReason: "end_turn" })]),
      ])

      expect(Array.from(frames)).toEqual([
        { messageStart: { role: "assistant" } },
        { messageStop: { stopReason: "end_turn" } },
      ])
    }),
  )

  it.effect("decodes only complete frames from a chunk with a truncated trailing frame", () =>
    Effect.gen(function* () {
      // 10 bytes is enough to read the length header but far short of the
      // declared frame length, so the remainder must be buffered, not failed.
      const partial = eventFrame("messageStop", { stopReason: "end_turn" }).subarray(0, 10)
      const frames = yield* decode([concat([eventFrame("messageStart", { role: "assistant" }), partial])])

      expect(Array.from(frames)).toEqual([{ messageStart: { role: "assistant" } }])
    }),
  )

  it.effect("reassembles a frame split across chunks", () =>
    Effect.gen(function* () {
      const frame = eventFrame("messageStop", { stopReason: "end_turn" })
      const split = Math.floor(frame.length / 2)
      const frames = yield* decode([frame.slice(0, split), frame.slice(split)])

      expect(Array.from(frames)).toEqual([{ messageStop: { stopReason: "end_turn" } }])
    }),
  )

  it.effect("fails to decode a frame whose declared length is below the event-stream overhead", () =>
    Effect.gen(function* () {
      // The 4-byte length header declares 8 bytes and the chunk supplies
      // enough, but a valid frame needs at least 16 bytes of overhead, so the
      // codec rejects it and the framer surfaces a typed decode error.
      const chunk = new Uint8Array(24)
      new DataView(chunk.buffer).setUint32(0, 8, false)
      const error = yield* decode([chunk]).pipe(Effect.flip)

      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.message).toContain("Failed to decode Bedrock Converse event-stream frame")
    }),
  )

  it.effect("fails to decode a frame with a corrupt message checksum", () =>
    Effect.gen(function* () {
      const frame = eventFrame("messageStop", { stopReason: "end_turn" }).slice()
      frame[frame.length - 1] ^= 0xff
      const error = yield* decode([frame]).pipe(Effect.flip)

      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.message).toContain("Failed to decode Bedrock Converse event-stream frame")
    }),
  )
})
