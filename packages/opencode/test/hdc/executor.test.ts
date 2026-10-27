import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { HdcExecutor } from "../../src/hdc/executor"
import { HdcDenial } from "../../src/hdc/reason"

// The fake `hdc` is a bun script; Windows cannot execute a script
// named `hdc.exe`, so the spawn-backed tests run on unix only.
const isUnix = process.platform !== "win32"

async function makeFakeDevEcoHome(withHdc: boolean): Promise<{ home: string; clean(): Promise<void> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-fake-home-"))
  await fs.mkdir(path.join(home, "tools", "node", "bin"), { recursive: true })
  await fs.writeFile(path.join(home, "tools", "node", "bin", "node"), "")
  await fs.writeFile(path.join(home, "product-info.json"), JSON.stringify({ version: "6.0.0" }))
  if (withHdc) {
    const toolchains = path.join(home, "sdk", "default", "openharmony", "toolchains")
    await fs.mkdir(toolchains, { recursive: true })
    await fs.writeFile(
      path.join(toolchains, "hdc"),
      // Top-level `return` is a syntax error when bun parses the
      // shebang script as ESM on Linux CI — use an if/else chain.
      [
        "#!/usr/bin/env bun",
        "const args = process.argv.slice(2)",
        "if (args[0] === 'list' && args[1] === 'targets') {",
        "  if (process.env.FAKE_HDC_EMPTY === '1') { console.log('[Empty]') } else { console.log('fake-device-1') }",
        "  process.exit(0)",
        "} else if (args[0] === 'hilog') {",
        "  process.stderr.write('fake hilog\\n'); process.exit(3)",
        "} else if (args[0] === 'env-check') {",
        "  const leaked = Object.keys(process.env).filter((k) => k.toUpperCase().startsWith('DEVECO_CODE_HDC_'))",
        "  const sep = process.platform === 'win32' ? ';' : ':'",
        "  const pathHasBin = (process.env.PATH ?? '').split(sep).some((p) => p === process.env.FAKE_EXPECTED_BIN_DIR)",
        "  console.log(JSON.stringify({ leaked, pathHasBin }))",
        "  process.exit(0)",
        "} else if (args[0] === 'echo-stdin') {",
        "  let input = ''",
        "  process.stdin.setEncoding('utf8')",
        "  process.stdin.on('data', (d) => { input += d })",
        "  process.stdin.on('end', () => { console.log('received:' + input); process.exit(0) })",
        "} else {",
        "  console.log(JSON.stringify(args))",
        "}",
      ].join("\n"),
    )
    await fs.chmod(path.join(toolchains, "hdc"), 0o755)
  }
  return { home, clean: () => fs.rm(home, { recursive: true, force: true }) }
}

describe("hdc executor", () => {
  test.skipIf(!isUnix)("execHdc runs the real binary by absolute path and streams output", async () => {
    const { home, clean } = await makeFakeDevEcoHome(true)
    process.env.DEVECO_HOME = home
    try {
      const chunks: string[] = []
      const code = await HdcExecutor.execHdc({
        argv: ["shell", "getprop", "ro.build.version"],
        onStdout: (chunk) => chunks.push(chunk.toString("utf8")),
        onStderr: () => {},
      })
      expect(code).toBe(0)
      expect(JSON.parse(chunks.join(""))).toEqual(["shell", "getprop", "ro.build.version"])
    } finally {
      delete process.env.DEVECO_HOME
      await clean()
    }
  })

  test.skipIf(!isUnix)("execHdc mirrors non-zero exit codes", async () => {
    const { home, clean } = await makeFakeDevEcoHome(true)
    process.env.DEVECO_HOME = home
    try {
      let stderr = ""
      const code = await HdcExecutor.execHdc({
        argv: ["hilog"],
        onStdout: () => {},
        onStderr: (chunk) => {
          stderr += chunk.toString("utf8")
        },
      })
      expect(code).toBe(3)
      expect(stderr).toContain("fake hilog")
    } finally {
      delete process.env.DEVECO_HOME
      await clean()
    }
  })

  test.skipIf(!isUnix)("fails closed with hdc_unavailable when the hdc binary is missing", async () => {
    const { home, clean } = await makeFakeDevEcoHome(false)
    process.env.DEVECO_HOME = home
    try {
      const promise = HdcExecutor.execHdc({ argv: ["-v"], onStdout: () => {}, onStderr: () => {} })
      await expect(promise).rejects.toBeInstanceOf(HdcDenial)
      await expect(promise).rejects.toMatchObject({ reasonCode: "hdc_unavailable" })
    } finally {
      delete process.env.DEVECO_HOME
      await clean()
    }
  })

  test.skipIf(!isUnix)("scrubs DEVECO_CODE_HDC_* and the shim dir from the child environment", async () => {
    const { home, clean } = await makeFakeDevEcoHome(true)
    process.env.DEVECO_HOME = home
    process.env.DEVECO_CODE_HDC_ENDPOINT = "tcp://should-not-leak"
    process.env.DEVECO_CODE_HDC_TOKEN = "leak-me-not"
    process.env.PATH = `${Global.Path.bin}${path.delimiter}${process.env.PATH ?? ""}`
    process.env.FAKE_EXPECTED_BIN_DIR = Global.Path.bin
    try {
      const chunks: string[] = []
      // `env-check` is not a parseable op, but the executor is the unit
      // under test here: any argv may be executed directly.
      const code = await HdcExecutor.execHdc({
        argv: ["env-check"],
        onStdout: (chunk) => chunks.push(chunk.toString("utf8")),
        onStderr: () => {},
      })
      expect(code).toBe(0)
      const seen = JSON.parse(chunks.join("")) as { leaked: string[]; pathHasBin: boolean }
      expect(seen.leaked).toEqual([])
      expect(seen.pathHasBin).toBe(false)
    } finally {
      delete process.env.DEVECO_HOME
      delete process.env.DEVECO_CODE_HDC_ENDPOINT
      delete process.env.DEVECO_CODE_HDC_TOKEN
      delete process.env.FAKE_EXPECTED_BIN_DIR
      await clean()
    }
  })

  test.skipIf(!isUnix)("forwards stdinBridge writes to the child's stdin and ends it", async () => {
    const { home, clean } = await makeFakeDevEcoHome(true)
    process.env.DEVECO_HOME = home
    try {
      const chunks: string[] = []
      const bridge = HdcExecutor.createStdinSink()
      // Writes before execHdc attaches the bridge are buffered and
      // replayed to the child's stdin in order.
      bridge.sink.write(Buffer.from("hello "))
      bridge.sink.write(Buffer.from("world"))
      const exec = HdcExecutor.execHdc({
        argv: ["echo-stdin"],
        onStdout: (chunk) => chunks.push(chunk.toString("utf8")),
        onStderr: () => {},
        stdinBridge: bridge,
      })
      // End while execution is in flight: Bun delivers no stdin EOF
      // unless the pipe is ended, and the echo-stdin child exits only
      // on EOF — ending after `await exec` would deadlock. Ending now
      // queues the end ahead of attach, so the buffered writes replay
      // in order and then the child's stdin closes.
      bridge.sink.end()
      const code = await exec
      expect(code).toBe(0)
      expect(chunks.join("")).toContain("received:hello world")
    } finally {
      delete process.env.DEVECO_HOME
      await clean()
    }
  })

  test("createStdinSink buffers writes before attach and replays in order", () => {
    const bridge = HdcExecutor.createStdinSink()
    const received: string[] = []
    let ended = false
    const target: HdcExecutor.StdinSink = {
      write: (chunk) => received.push(chunk.toString("utf8")),
      end: () => {
        ended = true
      },
    }

    // Writes before attach are buffered.
    bridge.sink.write(Buffer.from("one:"))
    bridge.sink.write(Buffer.from("two"))

    // Attach replays buffered writes in order.
    bridge.attach(target)
    expect(received.join("")).toBe("one:two")
    expect(ended).toBe(false)

    // Writes after attach go straight through; end is delivered once.
    bridge.sink.write(Buffer.from(":three"))
    bridge.sink.end()
    bridge.sink.write(Buffer.from(":ignored"))
    bridge.sink.end()
    expect(received.join("")).toBe("one:two:three")
    expect(ended).toBe(true)
  })

  test("createStdinSink delivers end queued before attach", () => {
    const bridge = HdcExecutor.createStdinSink()
    const received: string[] = []
    let ended = false
    bridge.sink.write(Buffer.from("a"))
    bridge.sink.end()
    bridge.attach({
      write: (chunk) => received.push(chunk.toString("utf8")),
      end: () => {
        ended = true
      },
    })
    expect(received.join("")).toBe("a")
    expect(ended).toBe(true)
  })

  describe("listTargets", () => {
    test.skipIf(!isUnix)("parses connected targets and filters [Empty]", async () => {
      const { home, clean } = await makeFakeDevEcoHome(true)
      process.env.DEVECO_HOME = home
      try {
        expect(await HdcExecutor.listTargets()).toEqual(["fake-device-1"])
        HdcExecutor.invalidateTargetsCache()
        process.env.FAKE_HDC_EMPTY = "1"
        expect(await HdcExecutor.listTargets()).toEqual([])
        HdcExecutor.invalidateTargetsCache()
      } finally {
        delete process.env.DEVECO_HOME
        delete process.env.FAKE_HDC_EMPTY
        HdcExecutor.invalidateTargetsCache()
        await clean()
      }
    })

    test.skipIf(!isUnix)("caches targets for repeated calls", async () => {
      const { home, clean } = await makeFakeDevEcoHome(true)
      process.env.DEVECO_HOME = home
      try {
        await HdcExecutor.listTargets()
        // Break the binary: the cached result must still be served.
        await fs.rm(path.join(home, "sdk", "default", "openharmony", "toolchains", "hdc"))
        expect(await HdcExecutor.listTargets()).toEqual(["fake-device-1"])
      } finally {
        delete process.env.DEVECO_HOME
        HdcExecutor.invalidateTargetsCache()
        await clean()
      }
    })
  })
})
