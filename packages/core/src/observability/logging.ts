import { Effect, FileSystem, Formatter, Logger, Option, type LogLevel } from "effect"
import path from "path"
import { Global } from "../global"
import { runID } from "./shared"

export function formatTimestamp(input: Date | string): string {
  const date = input instanceof Date ? input : new Date(input)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", formatTimestamp(output.timestamp)],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

const DEFAULT_MAX_BYTES = FileSystem.MiB(10)
const MIN_MAX_BYTES = FileSystem.MiB(1)

export function fileLogger(file = path.join(Global.Path.log, "deveco.log"), id: string = runID) {
  // Do not set batchWindow to 0; it causes high idle CPU usage.
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const encoder = new TextEncoder()
    const maxBytes = normalizeMaxBytes()
    const flush = (output: string[]) =>
      Effect.gen(function* () {
        const data = encoder.encode(output.join("\n") + "\n")
        const size = yield* fs.stat(file).pipe(Effect.map((info) => BigInt(info.size)), Effect.orElseSucceed(() => 0n))
        if (size > 0n && size + BigInt(data.byteLength) > maxBytes) {
          // 拆分：当前文件改名为带时间戳的归档，再写新文件继续追加；旧归档只增不减、不轮转、不清理
          yield* splitFile(fs, file)
        }
        yield* fs.writeFile(file, data, { flag: "a" })
      }).pipe(Effect.ignore)
    return yield* Logger.batched(formatter(id), { window: 1000, flush })
  })
}

// 读取并归一化 maxBytes：未设置或非法值（NaN/Infinity/0/负数）回落默认 10 MiB；
// 合法但小于 1 MiB 时钳到 1 MiB，避免上限过小导致每次 flush 都拆分、归档文件爆炸
function normalizeMaxBytes(): bigint {
  const parsed = process.env.DEVECO_LOG_MAX_BYTES ? Number(process.env.DEVECO_LOG_MAX_BYTES) : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= 0) return BigInt(DEFAULT_MAX_BYTES)
  return BigInt(Math.max(Math.floor(parsed), Number(MIN_MAX_BYTES)))
}

function splitFile(fs: FileSystem.FileSystem, file: string) {
  return Effect.gen(function* () {
    const stamp = yield* archiveStamp(fs, file)
    let target = splitPath(file, stamp)
    let i = 1
    while (yield* fs.exists(target)) {
      // rename 会静默覆盖目标，撞名时加 -n 后缀兜底，避免覆盖已有归档
      target = splitPath(file, `${stamp}-${i}`)
      i += 1
    }
    yield* fs.rename(file, target)
  })
}

// 归档名取文件内最早一条日志的时间戳（首行 timestamp= 字段），这样按名字即可定位每个文件的覆盖范围；
// 读取失败或首行无法解析时回退到拆分时刻的当前时间
function archiveStamp(fs: FileSystem.FileSystem, file: string) {
  return Effect.gen(function* () {
    const head = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(file)
        const bytes = yield* handle.readAlloc(512)
        return Option.getOrElse(bytes, () => new Uint8Array())
      }),
    )
    const firstLine = new TextDecoder().decode(head).split("\n")[0]
    // 真实日志行形如 timestamp="2026-10-21 11:42:08"（含空格的值被 JSON 转义加引号），也兼容无引号旧格式
    const match = /^timestamp="?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"?/.exec(firstLine)
    return match ? match[1].replace(/[:\s]/g, "-") : splitStamp()
  }).pipe(Effect.orElseSucceed(splitStamp))
}

function splitStamp() {
  return formatTimestamp(new Date()).replace(/[:\s]/g, "-")
}

function splitPath(file: string, stamp: string) {
  return file.endsWith(".log") ? `${file.slice(0, -4)}-${stamp}.log` : `${file}-${stamp}`
}

const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function minimumLogLevel() {
  const value = process.env.DEVECO_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.DEVECO_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger] : [fileLogger()]
}

export * as Logging from "./logging"
