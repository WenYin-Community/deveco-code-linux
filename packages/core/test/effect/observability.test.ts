import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Logger } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileLogger } from "../../src/observability/logging"
import { parseOtlpHeaders, resource } from "../../src/observability/otlp"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const opencodeClient = process.env.DEVECO_CLIENT
const logMaxBytes = process.env.DEVECO_LOG_MAX_BYTES

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (opencodeClient === undefined) delete process.env.DEVECO_CLIENT
  else process.env.DEVECO_CLIENT = opencodeClient

  if (logMaxBytes === undefined) delete process.env.DEVECO_LOG_MAX_BYTES
  else process.env.DEVECO_LOG_MAX_BYTES = logMaxBytes
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=anomalyco,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "anomalyco",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=anomalyco,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["opencode.client"]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.DEVECO_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "opencode.client=web,service.instance.id=override,service.namespace=anomalyco"

    expect(resource().attributes).toMatchObject({
      "opencode.client": "cli",
      "service.namespace": "anomalyco",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
    expect(resource().attributes["opencode.run"]).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("parseOtlpHeaders", () => {
  test("parses key=value pairs", () => {
    const result = parseOtlpHeaders('a=1,b=2');
    expect(result).toEqual({ a: '1', b: '2' });
  });

  test('preserves = in value', () => {
    const result = parseOtlpHeaders('auth=Bearer abc=def');
    expect(result).toEqual({ auth: 'Bearer abc=def' });
  });

  test('rejects CRLF in key (header injection)', () => {
    const result = parseOtlpHeaders('a\r\nb=1,c=2');
    expect(result).toEqual({ c: '2' });
  });

  test('rejects CRLF in value (header injection)', () => {
    const result = parseOtlpHeaders('a=1\r\n,b=2');
    expect(result).toEqual({ b: '2' });
  });

  test('rejects oversized key (>1024 chars)', () => {
    const longKey = 'x'.repeat(1025);
    const result = parseOtlpHeaders(longKey + '=1,b=2');
    expect(result).toEqual({ b: '2' });
  });

  test('rejects oversized value (>8192 chars)', () => {
    const longVal = 'x'.repeat(8193);
    const result = parseOtlpHeaders('a=' + longVal + ',b=2');
    expect(result).toEqual({ b: '2' });
  });

  test('skips empty key', () => {
    const result = parseOtlpHeaders('=1,b=2');
    expect(result).toEqual({ b: '2' });
  });

  test('returns empty object for empty string', () => {
    expect(parseOtlpHeaders('')).toEqual({});
  });
})

test("file logger appends concurrent runs with a run on every line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  const write = (runID: string) =>
    Effect.forEach(
      Array.from({ length: 50 }, (_, index) => index),
      (index) => Effect.logInfo(`entry-${index}`),
    ).pipe(
      Effect.provide(Logger.layer([fileLogger(file, runID)]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
      Effect.scoped,
    )

  await Effect.runPromise(Effect.all([write("run-a"), write("run-b")], { concurrency: "unbounded" }))

  const lines = (await Bun.file(file).text()).trim().split("\n")
  expect(lines).toHaveLength(100)
  expect(lines.filter((line) => line.includes("run=run-a"))).toHaveLength(50)
  expect(lines.filter((line) => line.includes("run=run-b"))).toHaveLength(50)
  expect(lines.every((line) => line.startsWith("timestamp=") && line.includes(" level=INFO "))).toBe(true)
  expect(lines.every((line) => !line.includes(" fiber="))).toBe(true)
  expect(lines.every((line) => !line.startsWith("{"))).toBe(true)
})

test("file logger flattens nested objects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")

  await Effect.logInfo("request complete", {
    request: { method: "GET", timing: { duration: 42 } },
    tags: ["api", "test"],
  }).pipe(
    Effect.annotateLogs({ session: { id: "session-1" } }),
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const line = (await Bun.file(file).text()).trim()
  expect(line).toContain('message="request complete"')
  expect(line).toContain("request.method=GET")
  expect(line).toContain("request.timing.duration=42")
  expect(line).toContain('tags="[\\\"api\\\",\\\"test\\\"]"')
  expect(line).toContain("session.id=session-1")
  expect(line).not.toContain("request={")
})

test("file logger splits into a timestamped archive past maxBytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  const seed = "filler-line\n".repeat(200_000) // ~2.4 MB，超过 1 MiB 下限，确保首个 flush 即拆分
  await fs.writeFile(file, seed)
  const batch = (prefix: string, n: number) =>
    Effect.forEach(Array.from({ length: n }, (_, index) => index), (index) => Effect.logInfo(`${prefix}-${index}`))

  process.env.DEVECO_LOG_MAX_BYTES = String(FileSystem.MiB(1))
  await Effect.gen(function* () {
    yield* batch("first", 10)
    yield* Effect.sleep("1500 millis")
    yield* batch("second", 10)
  }).pipe(
    Effect.provide(
      Logger.layer([fileLogger(file, "run-a")]).pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.orDie,
      ),
    ),
    Effect.scoped,
    Effect.runPromise,
  )

  const archives = (await fs.readdir(dir)).filter((name) => name.endsWith(".log") && name !== "opencode.log")
  expect(archives).toHaveLength(1)
  expect(archives[0]).toMatch(/^opencode-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-\d+)?\.log$/)
  expect((await fs.stat(path.join(dir, archives[0]))).size).toBe(seed.length) // 历史大文件整体归档，不截断

  const current = (await Bun.file(file).text()).trim().split("\n")
  expect(current).toHaveLength(20)
  expect(current.filter((line) => line.includes("first-"))).toHaveLength(10)
  expect(current.filter((line) => line.includes("second-"))).toHaveLength(10)
  expect((await fs.stat(file)).size).toBeLessThan(FileSystem.MiB(1))
})

test("file logger keeps timestamped archives without deleting or overwriting old ones", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  const seed = "filler-line\n".repeat(200_000) // ~2.4 MB
  await fs.writeFile(file, seed)
  const batch = (prefix: string, n: number) =>
    Effect.forEach(Array.from({ length: n }, (_, index) => index), (index) => Effect.logInfo(`${prefix}-${index}`))

  process.env.DEVECO_LOG_MAX_BYTES = String(FileSystem.MiB(1))
  await Effect.gen(function* () {
    yield* batch("one", 10)
    yield* Effect.sleep("1500 millis") // 首个 flush：预置大文件超限 → 拆出归档 1
    yield* Effect.promise(() => fs.appendFile(file, seed)) // 当前文件重新超限，触发下一次拆分
    yield* Effect.sleep("1500 millis")
    yield* batch("two", 10)
    yield* Effect.sleep("1500 millis") // 第二次 flush → 拆出归档 2
  }).pipe(
    Effect.provide(
      Logger.layer([fileLogger(file, "run-a")]).pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.orDie,
      ),
    ),
    Effect.scoped,
    Effect.runPromise,
  )

  const archives = (await fs.readdir(dir)).filter((name) => name.endsWith(".log") && name !== "opencode.log")
  expect(archives.length).toBeGreaterThanOrEqual(2)
  expect(new Set(archives).size).toBe(archives.length)

  const bodies = [
    (await Bun.file(file).text()).trim(),
    ...(await Promise.all(archives.map((name) => Bun.file(path.join(dir, name)).text()))).map((text) => text.trim()),
  ]
  const lines = bodies.join("\n").split("\n")
  expect(lines.filter((line) => line.includes("one-"))).toHaveLength(10)
  expect(lines.filter((line) => line.includes("two-"))).toHaveLength(10)
})

test("file logger names archives by the earliest timestamp in the file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  await fs.writeFile(
    file,
    'timestamp="2026-01-02 03:04:05" level=INFO run=run-a message=old\n' + "filler-line\n".repeat(200_000),
  )
  process.env.DEVECO_LOG_MAX_BYTES = String(FileSystem.MiB(1))
  await Effect.gen(function* () {
    yield* Effect.forEach(Array.from({ length: 10 }, (_, index) => index), (index) => Effect.logInfo(`entry-${index}`))
    yield* Effect.sleep("1500 millis")
  }).pipe(
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const archives = (await fs.readdir(dir)).filter((name) => name.endsWith(".log") && name !== "opencode.log")
  expect(archives).toHaveLength(1)
  expect(archives[0]).toBe("opencode-2026-01-02-03-04-05.log")
})

test("file logger clamps sub-MiB or invalid maxBytes without crashing or splitting every flush", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  const run = () =>
    Effect.gen(function* () {
      yield* Effect.forEach(Array.from({ length: 10 }, (_, index) => index), (index) => Effect.logInfo(`entry-${index}`))
    }).pipe(
      Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
      Effect.scoped,
      Effect.runPromise,
    )

  for (const value of ["1", "0", "NaN", "1.5"]) {
    // 1 → 钳到 1 MiB；0/NaN → 回落默认 10 MiB；1.5 → floor 后钳到 1 MiB，均不崩溃、不拆分
    process.env.DEVECO_LOG_MAX_BYTES = value
    await run()
  }

  const archives = (await fs.readdir(dir)).filter((name) => name.endsWith(".log") && name !== "opencode.log")
  expect(archives).toHaveLength(0)
  const lines = (await Bun.file(file).text()).trim().split("\n")
  expect(lines).toHaveLength(40)
})

test("DEVECO_LOG_MAX_BYTES below the minimum is clamped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  process.env.DEVECO_LOG_MAX_BYTES = "1"
  await Effect.forEach(Array.from({ length: 10 }, (_, index) => index), (index) => Effect.logInfo(`entry-${index}`)).pipe(
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )
  const archives = (await fs.readdir(dir)).filter((name) => name.endsWith(".log") && name !== "opencode.log")
  expect(archives).toHaveLength(0)
  const lines = (await Bun.file(file).text()).trim().split("\n")
  expect(lines).toHaveLength(10)
})

test("file logger appends a -n suffix when the archive name collides", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  const archive = "opencode-2026-01-02-03-04-05.log"
  // 预置同名归档触发撞名兜底：旧归档必须原样保留，新归档从 -1 后缀开始
  await fs.writeFile(path.join(dir, archive), "existing archive\n")
  await fs.writeFile(
    file,
    'timestamp="2026-01-02 03:04:05" level=INFO run=run-a message=old\n' + "filler-line\n".repeat(200_000),
  )
  process.env.DEVECO_LOG_MAX_BYTES = String(FileSystem.MiB(1))
  await Effect.gen(function* () {
    yield* Effect.forEach(Array.from({ length: 10 }, (_, index) => index), (index) => Effect.logInfo(`entry-${index}`))
    yield* Effect.sleep("1500 millis")
  }).pipe(
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const archives = (await fs.readdir(dir)).filter((name) => name.endsWith(".log") && name !== "opencode.log")
  expect(archives).toContain(archive)
  expect(archives).toContain("opencode-2026-01-02-03-04-05-1.log")
  expect(await Bun.file(path.join(dir, archive)).text()).toBe("existing archive\n")
})
