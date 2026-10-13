import { expect, test } from "bun:test"
import { readImageDimensions } from "@/tool/design-tools/component-recognition/component-recognition-tool"

function bytes(...parts: Array<Array<number> | string>): Uint8Array {
  const flat = parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part))
  return new Uint8Array(flat)
}

test("reads PNG dimensions from the IHDR chunk", () => {
  const png = bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    [0, 0, 0, 13],
    "IHDR",
    [0, 0, 0, 2],
    [0, 0, 0, 3],
    [0x08, 0x06, 0, 0, 0],
  )
  expect(readImageDimensions(png, "image/png")).toEqual({ width: 2, height: 3 })
})

test("reads JPEG dimensions from the SOF0 marker (height before width)", () => {
  const jpeg = bytes([0xff, 0xd8], [0xff, 0xc0], [0x00, 0x11], [0x08], [0x00, 0x03], [0x00, 0x02], [0x01, 0x01, 0x00])
  expect(readImageDimensions(jpeg, "image/jpeg")).toEqual({ width: 2, height: 3 })
})

test("reads GIF dimensions from the logical screen descriptor", () => {
  const gif = bytes("GIF89a", [2, 0], [3, 0], [0x00], [0x00], [0x00], [0x3b])
  expect(readImageDimensions(gif, "image/gif")).toEqual({ width: 2, height: 3 })
})

test("reads WebP VP8X dimensions (1 + stored side)", () => {
  const webp = bytes(
    "RIFF",
    [0x1a, 0x00, 0x00, 0x00],
    "WEBP",
    "VP8X",
    [0x0a, 0x00, 0x00, 0x00],
    [0x00, 0x00, 0x00, 0x00],
    [1, 0, 0],
    [2, 0, 0],
  )
  expect(readImageDimensions(webp, "image/webp")).toEqual({ width: 2, height: 3 })
})

test("returns undefined for unknown mime types", () => {
  const png = bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    [0, 0, 0, 13],
    "IHDR",
    [0, 0, 0, 2],
    [0, 0, 0, 3],
    [0],
  )
  expect(readImageDimensions(png, "image/bmp")).toBeUndefined()
})

test("returns undefined for truncated images", () => {
  expect(readImageDimensions(new Uint8Array(8), "image/png")).toBeUndefined()
  expect(readImageDimensions(new Uint8Array(4), "image/gif")).toBeUndefined()
  expect(readImageDimensions(new Uint8Array(10), "image/webp")).toBeUndefined()
})

test("returns undefined for non-positive dimensions", () => {
  const png = bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    [0, 0, 0, 13],
    "IHDR",
    [0, 0, 0, 0],
    [0, 0, 0, 3],
    [0],
  )
  expect(readImageDimensions(png, "image/png")).toBeUndefined()
})
