import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Project } from "@/project/project"
import { testEffect } from "../lib/effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Hash } from "@opencode-ai/core/util/hash"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { NodePath } from "@effect/platform-node"
import { RuntimeFlags } from "@/effect/runtime-flags"

const it = testEffect(Layer.empty)

const PNG_BYTES = new Uint8Array(
  await Bun.file(new URL("../../../ui/src/assets/favicon/favicon-96x96.png", import.meta.url)).arrayBuffer(),
)
const JPEG_BYTES = new Uint8Array(
  await Bun.file(new URL("./fixture-jpeg.jpg", import.meta.url)).arrayBuffer(),
)
const TRUNCATED_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])
const NOT_IMAGE_BYTES = new Uint8Array([0x3c, 0x73, 0x76, 0x67]) // "<svg"

const pngDataUrl = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`
const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString("base64")}`
const gifDataUrl = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
const webpDataUrl = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1) />").toString("base64")}`
const fakePngDataUrl = `data:image/png;base64,${Buffer.from(NOT_IMAGE_BYTES).toString("base64")}`

describe("Project.validateIconBytes", () => {
  it.effect("accepts valid PNG bytes", () =>
    Effect.gen(function* () {
      const err = Project.validateIconBytes(PNG_BYTES, 512 * 1024)
      expect(err).toBeUndefined()
    }),
  )

  it.effect("accepts valid JPEG bytes", () =>
    Effect.gen(function* () {
      const err = Project.validateIconBytes(JPEG_BYTES, 512 * 1024)
      expect(err).toBeUndefined()
    }),
  )

  it.effect("rejects non-image bytes", () =>
    Effect.gen(function* () {
      const err = Project.validateIconBytes(NOT_IMAGE_BYTES, 512 * 1024)
      expect(err).toBeInstanceOf(Project.InvalidIconError)
      expect(err?.reason).toBe("unrecognized_image_format")
    }),
  )

  it.effect("rejects oversized bytes", () =>
    Effect.gen(function* () {
      const err = Project.validateIconBytes(PNG_BYTES, 4)
      expect(err).toBeInstanceOf(Project.InvalidIconError)
      expect(err?.reason).toBe("icon_too_large")
    }),
  )

  it.effect("rejects oversized image dimensions before decoding", () =>
    Effect.gen(function* () {
      const bytes = PNG_BYTES.slice()
      bytes.set([0x00, 0x00, 0x20, 0x00], 16)
      const err = Project.validateIconBytes(bytes)
      expect(err).toBeInstanceOf(Project.InvalidIconError)
      expect(err?.reason).toBe("icon_dimensions_too_large")
    }),
  )
})

describe("Project.validateIconDataUrl", () => {
  it.effect("returns void for empty/undefined (clearing the icon)", () =>
    Effect.gen(function* () {
      expect(yield* Project.validateIconDataUrl(undefined)).toBeUndefined()
      expect(yield* Project.validateIconDataUrl("")).toBeUndefined()
    }),
  )

  it.effect("accepts a real PNG data URL", () =>
    Effect.gen(function* () {
      expect(yield* Project.validateIconDataUrl(pngDataUrl)).toBeUndefined()
    }),
  )

  it.effect("decodes every allowed image format", () =>
    Effect.gen(function* () {
      expect(yield* Project.validateIconDataUrl(jpegDataUrl)).toBeUndefined()
      expect(yield* Project.validateIconDataUrl(gifDataUrl)).toBeUndefined()
      expect(yield* Project.validateIconDataUrl(webpDataUrl)).toBeUndefined()
    }),
  )

  it.effect("rejects SVG data URL (XSS vector)", () =>
    Effect.gen(function* () {
      const err = yield* Project.validateIconDataUrl(svgDataUrl)
      expect(err).toBeInstanceOf(Project.InvalidIconError)
      expect(err?.reason).toBe("unrecognized_image_format")
    }),
  )

  it.effect("rejects fake PNG (real bytes are not PNG)", () =>
    Effect.gen(function* () {
      const err = yield* Project.validateIconDataUrl(fakePngDataUrl)
      expect(err).toBeInstanceOf(Project.InvalidIconError)
      expect(err?.reason).toBe("unrecognized_image_format")
    }),
  )

  it.effect("rejects a plain string that is not a data URL", () =>
    Effect.gen(function* () {
      const err = yield* Project.validateIconDataUrl("https://evil.example/x.png")
      expect(err).toBeInstanceOf(Project.InvalidIconError)
      expect(err?.reason).toBe("invalid_data_url")
    }),
  )

  it.effect("rejects an oversized data URL", () =>
    Effect.gen(function* () {
      const big = Buffer.alloc(600 * 1024, 0x89).toString("base64") // 600KB > 512KB limit
      const url = `data:image/png;base64,${big}`
      const err = yield* Project.validateIconDataUrl(url)
      expect(err).toBeInstanceOf(Project.InvalidIconError)
      expect(err?.reason).toBe("icon_too_large")
    }),
  )

  it.effect("rejects malformed base64 instead of decoding it permissively", () =>
    Effect.gen(function* () {
      const err = yield* Project.validateIconDataUrl(`${pngDataUrl}%%%`)
      expect(err).toBeInstanceOf(Project.InvalidIconError)
      expect(err?.reason).toBe("invalid_data_url")
    }),
  )

  it.effect("rejects a declared MIME that does not match the bytes", () =>
    Effect.gen(function* () {
      const err = yield* Project.validateIconDataUrl(pngDataUrl.replace("image/png", "image/jpeg"))
      expect(err).toBeInstanceOf(Project.InvalidIconError)
      expect(err?.reason).toBe("image_mime_mismatch")
    }),
  )

  it.effect("rejects a truncated image with a valid magic header", () =>
    Effect.gen(function* () {
      const err = yield* Project.validateIconDataUrl(
        `data:image/png;base64,${Buffer.from(TRUNCATED_PNG_BYTES).toString("base64")}`,
      )
      expect(err).toBeInstanceOf(Project.InvalidIconError)
      expect(err?.reason).toBe("invalid_image")
    }),
  )
})

const integrationLayer = Project.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.provide(ProjectDirectories.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(NodePath.layer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)
const integrationIt = testEffect(integrationLayer)

describe("Project.update icon validation", () => {
  integrationIt.live("rejects an SVG icon override", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const id = ProjectV2.ID.make(Hash.fast("icon-test-svg"))
      const error = yield* project.update({ projectID: id, icon: { override: svgDataUrl } }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Project.InvalidIconError)
    }),
  )

  integrationIt.live("rejects a fake PNG data URL", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const id = ProjectV2.ID.make(Hash.fast("icon-test-fake"))
      const error = yield* project.update({ projectID: id, icon: { override: fakePngDataUrl } }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Project.InvalidIconError)
    }),
  )

  integrationIt.live("rejects insecure remote icon URLs", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const id = ProjectV2.ID.make(Hash.fast("icon-test-http"))
      const error = yield* project
        .update({ projectID: id, icon: { url: "http://evil.example/icon.png" } })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Project.InvalidIconError)
      if (!(error instanceof Project.InvalidIconError)) throw error
      expect(error.reason).toBe("invalid_icon_url")
    }),
  )
})
