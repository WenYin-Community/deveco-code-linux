export * as HdcExecutor from "./executor"

import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { findDevEcoHome, hdcPath } from "@/tool/lib/env"
import { HdcDenial } from "./reason"

// ─── HDC executor (SR1) ─────────────────────────────────────
// Spawns the REAL hdc binary by absolute path with a scrubbed
// environment. The guard's own PATH additions (shim dir) and
// DEVECO_CODE_HDC_* vars are stripped so the child can never
// re-enter the guard (no recursion, no bypass).

export interface ExecOptions {
  // Full argv AFTER the hdc program token, e.g. ["shell", "getprop"].
  argv: string[]
  cwd?: string
  signal?: AbortSignal
  onStdout: (chunk: Buffer) => void
  onStderr: (chunk: Buffer) => void
  // When provided, the spawned hdc's stdin is a pipe fed by this
  // bridge. Without it stdin is ignored.
  stdinBridge?: HdcStdinBridge
}

// A stdin sink that buffers writes until the child's stdin is
// available (Bun's spawn stdin resolves asynchronously), then
// replays them in order. `end` is delivered after all buffered
// writes. Compatible with Bun's FileSink surface (write/end).
export interface StdinSink {
  write: (chunk: Buffer) => void
  end: () => void
}

export interface HdcStdinBridge {
  sink: StdinSink
  attach: (target: StdinSink) => void
}

export function createStdinSink(): HdcStdinBridge {
  const pending: Buffer[] = []
  let target: StdinSink | undefined
  let ended = false
  let endQueued = false

  return {
    sink: {
      write: (chunk: Buffer) => {
        if (ended) return
        if (target) target.write(chunk)
        else pending.push(chunk)
      },
      end: () => {
        if (ended) return
        ended = true
        if (target) target.end()
        else endQueued = true
      },
    },
    attach: (nextTarget: StdinSink) => {
      target = nextTarget
      for (const chunk of pending) nextTarget.write(chunk)
      pending.length = 0
      if (endQueued) {
        endQueued = false
        nextTarget.end()
      }
    },
  }
}

async function resolveHdcBinary(): Promise<string> {
  const home = await findDevEcoHome()
  if (!home) throw new HdcDenial("hdc_unavailable", "DevEco Studio installation not found; cannot locate the real hdc")
  const bin = hdcPath(home)
  if (!(await Bun.file(bin).exists())) {
    throw new HdcDenial("hdc_unavailable", `real hdc not found at ${bin} (fail closed)`)
  }
  return bin
}

function cleanSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.toUpperCase().startsWith("DEVECO_CODE_HDC_")) continue
    env[key] = value
  }

  // Strip the shim dir from PATH so the child cannot resolve our
  // `hdc` shim (case-insensitive compare on all platforms).
  const binDir = path.resolve(Global.Path.bin).toLowerCase()
  const sep = path.delimiter
  for (const key of new Set(process.platform === "win32" ? ["Path", "PATH", "path"] : ["PATH"])) {
    const value = env[key]
    if (!value) continue
    const filtered = value.split(sep).filter((entry) => entry.length > 0 && path.resolve(entry).toLowerCase() !== binDir)
    if (filtered.length === 0) delete env[key]
    else env[key] = filtered.join(sep)
  }
  return env
}

async function pump(stream: ReadableStream<Uint8Array> | undefined, emit: (chunk: Buffer) => void): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) emit(Buffer.from(value))
  }
}

export async function execHdc(options: ExecOptions): Promise<number> {
  const bin = await resolveHdcBinary()

  const proc = Bun.spawn([bin, ...options.argv], {
    cwd: options.cwd,
    env: cleanSpawnEnv(),
    stdin: options.stdinBridge ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  if (options.stdinBridge && proc.stdin) {
    options.stdinBridge.attach(proc.stdin)
  }

  const abort = () => proc.kill()
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) proc.kill()

  try {
    await Promise.all([pump(proc.stdout, options.onStdout), pump(proc.stderr, options.onStderr)])
  } finally {
    options.signal?.removeEventListener("abort", abort)
  }

  const code = await proc.exited
  if (options.signal?.aborted) throw new HdcDenial("cancelled", "hdc execution was cancelled")
  return code
}

// ─── Connected-device discovery ─────────────────────────────
// `hdc list targets` cached for ≤5s. `[Empty]` output lines are
// filtered; they appear when no device is attached.

const TARGETS_CACHE_MS = 5000

let targetsCache: { at: number; targets: string[] } | undefined

export function invalidateTargetsCache(): void {
  targetsCache = undefined
}

export async function listTargets(): Promise<string[]> {
  if (targetsCache && Date.now() - targetsCache.at < TARGETS_CACHE_MS) return targetsCache.targets

  let out = ""
  let err = ""
  const code = await execHdc({
    argv: ["list", "targets"],
    onStdout: (chunk) => {
      out += chunk.toString("utf8")
    },
    onStderr: (chunk) => {
      err += chunk.toString("utf8")
    },
  })
  if (code !== 0) {
    throw new HdcDenial("device_execution_failed", `\`hdc list targets\` failed (exit ${code})${err ? `: ${err.trim()}` : ""}`)
  }

  const targets = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "[Empty]")
  targetsCache = { at: Date.now(), targets }
  return targets
}
