import { describe, expect, test } from "bun:test"
import z from "zod"
import { Share } from "../../src/core/share"
import { Storage } from "../../src/core/storage"

describe("core.storage.decode", () => {
  test("should reject data that does not match the schema", () => {
    expect(() =>
      Storage.decode("test/invalid.json", JSON.stringify({ name: 42 }), z.object({ name: z.string() })),
    ).toThrow(Storage.InvalidDataError)
  })

  test("should reject malformed JSON without exposing its contents", () => {
    const value = '{"secret":"sensitive"'

    expect(() => Storage.decode("test/invalid.json", value, z.object({ secret: z.string() }))).toThrow(
      "Invalid storage data: test/invalid.json",
    )
    expect(() => Storage.decode("test/invalid.json", value, z.object({ secret: z.string() }))).not.toThrow("sensitive")
  })

  test("should preserve unknown fields", () => {
    const result = Storage.decode(
      "test/compatible.json",
      JSON.stringify({ name: "test", future: true }),
      z.looseObject({ name: z.string() }),
    )

    expect(result).toEqual({ name: "test", future: true })
  })

  test("should reject malformed share snapshots", () => {
    const value = JSON.stringify({ data: [{ type: "part", data: { id: "part1", sessionID: "session1" } }] })

    expect(() => Storage.decode("share_snapshot/test.json", value, Share.Snapshot)).toThrow(Storage.InvalidDataError)
  })

  test("should preserve additional share data fields", () => {
    const value = {
      data: [
        {
          type: "part" as const,
          data: {
            id: "part1",
            sessionID: "session1",
            messageID: "message1",
            type: "future-part",
            future: true,
          },
        },
      ],
      version: 2,
    }

    const result = Storage.decode("share_snapshot/test.json", JSON.stringify(value), Share.Snapshot)
    const item = result.data[0]

    expect(result.version).toBe(2)
    expect(item?.type).toBe("part")
    if (item?.type !== "part") throw new Error("Expected part data")
    expect(item.data.future).toBe(true)
  })
})
