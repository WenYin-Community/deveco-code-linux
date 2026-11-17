import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { prepareMasterGoCapture } from "../resources/skills/hmos-design-to-arkts/scripts/mastergo-capture.mjs"
import { tmpdir } from "./fixture/fixture"

const RUN = ".deveco/design-to-arkts-fast/runs/capture-gate"

// A 33-byte PNG header: signature, IHDR length and the declared pixel size.
function png(width: number, height: number) {
  const header = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
  header.writeUInt32BE(13, 8)
  header.write("IHDR", 12, "ascii")
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  header[24] = 8
  header[25] = 6
  return header
}

function capture(overrides: Record<string, unknown> = {}) {
  return { operation: "read", server: "mastergo-magic", tool: "getDsl", runDir: RUN, ...overrides }
}

async function mastergoRun(root: string, channel?: string) {
  const runDir = path.join(root, RUN)
  const exportDir = path.join(runDir, "source", "mastergo", "export")
  await fs.mkdir(runDir, { recursive: true })
  await Bun.write(
    path.join(runDir, "workflow-state.json"),
    JSON.stringify({ designSource: "mastergo", currentStage: 1, status: "running" }),
  )
  if (channel) {
    await Bun.write(path.join(runDir, "requirement-clarification.json"), JSON.stringify({ mastergo: { channel } }))
  }
  return { runDir, exportDir }
}

describe("mastergo-capture screenshot gate", () => {
  test("rejects design reading when a pure Magic run has no screenshot", async () => {
    await using tmp = await tmpdir()
    const { exportDir } = await mastergoRun(tmp.path, "magic-manual")
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).toThrow(exportDir)
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).toThrow("missing_asset")
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).toThrow("blocked")
  })

  test("rejects a placeholder screenshot that is too small", async () => {
    await using tmp = await tmpdir()
    const { exportDir } = await mastergoRun(tmp.path, "magic-manual")
    await fs.mkdir(exportDir, { recursive: true })
    await Bun.write(path.join(exportDir, "board-1x.png"), png(8, 8))
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).toThrow("smaller than 32px: board-1x.png is 8x8")
  })

  test("rejects an empty or unreadable screenshot file", async () => {
    await using tmp = await tmpdir()
    const { exportDir } = await mastergoRun(tmp.path, "magic-manual")
    await fs.mkdir(exportDir, { recursive: true })
    const file = path.join(exportDir, "board-1x.png")
    await Bun.write(file, "")
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).toThrow("empty file: board-1x.png")
    await Bun.write(file, "not a PNG")
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).toThrow("unreadable PNG: board-1x.png")
  })

  test("rejects a screenshot above the pixel limit", async () => {
    await using tmp = await tmpdir()
    const { exportDir } = await mastergoRun(tmp.path, "magic-manual")
    await fs.mkdir(exportDir, { recursive: true })
    await Bun.write(path.join(exportDir, "board-1x.png"), png(20000, 3000))
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).toThrow("over 40M pixels: board-1x.png is 20000x3000")
  })

  test("rejects a screenshot above the size limit", async () => {
    await using tmp = await tmpdir()
    const { exportDir } = await mastergoRun(tmp.path, "magic-manual")
    await fs.mkdir(exportDir, { recursive: true })
    const file = path.join(exportDir, "board-1x.png")
    await Bun.write(file, png(1000, 1000))
    // Extend the file without materialising 10 MiB of image bytes.
    await fs.truncate(file, 10 * 1024 * 1024 + 1)
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).toThrow("10 MiB")
  })

  test("accepts a pure Magic run once the user screenshot is in place", async () => {
    await using tmp = await tmpdir()
    const { exportDir } = await mastergoRun(tmp.path, "magic-manual")
    await fs.mkdir(exportDir, { recursive: true })
    await Bun.write(path.join(exportDir, "board-1x.png"), png(64, 64))
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).not.toThrow()
  })

  test("leaves mixed and unrecorded channels alone", async () => {
    await using tmp = await tmpdir()
    await mastergoRun(tmp.path, "mixed")
    expect(prepareMasterGoCapture(capture(), tmp.path)).toMatchObject({ operation: "call", tool: "getDsl" })
    const unrecorded = path.join(tmp.path, ".deveco", "design-to-arkts-fast", "runs", "unrecorded")
    await fs.mkdir(unrecorded, { recursive: true })
    await Bun.write(
      path.join(unrecorded, "workflow-state.json"),
      JSON.stringify({ designSource: "mastergo", currentStage: 1, status: "running" }),
    )
    expect(() =>
      prepareMasterGoCapture(capture({ runDir: path.relative(tmp.path, unrecorded) }), tmp.path),
    ).not.toThrow()
  })

  test("keeps tool discovery available without a screenshot", async () => {
    await using tmp = await tmpdir()
    await mastergoRun(tmp.path, "magic-manual")
    expect(prepareMasterGoCapture(capture({ operation: "tools" }), tmp.path)).toMatchObject({ operation: "tools" })
  })
})

describe("mastergo-capture preflight messages", () => {
  test("names the clarification file when it is not valid JSON", async () => {
    await using tmp = await tmpdir()
    const { runDir } = await mastergoRun(tmp.path, "magic-manual")
    await Bun.write(path.join(runDir, "requirement-clarification.json"), "{ broken")
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).toThrow(
      "requirement-clarification.json is not valid JSON",
    )
    expect(() => prepareMasterGoCapture(capture(), tmp.path)).toThrow(runDir)
  })

  test("asks for the project root when the run directory is not resolvable", async () => {
    await using tmp = await tmpdir()
    expect(() => prepareMasterGoCapture(capture({ runDir: "some/other/dir" }), tmp.path)).toThrow(
      "run it from the project root",
    )
  })
})
