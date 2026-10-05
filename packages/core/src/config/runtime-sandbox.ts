import type { SandboxConfig } from "./sandbox"
import { Global } from "../global"
import path from "node:path"
import { readFile, writeFile, unlink, rename, mkdir } from "node:fs/promises"

// Runtime sandbox override (S-SESS-1).
// TUI and server run in separate processes, so globalThis/module-level state
// cannot be shared. Instead we persist the override to a file that both sides
// can access: <data_dir>/runtime-sandbox.json

const FILENAME = "runtime-sandbox.json"

function filepath(): string {
  return path.join(Global.Path.data, FILENAME)
}

export async function setRuntimeSandbox(config: SandboxConfig | undefined) {
  const fp = filepath()
  if (!config) {
    try {
      await unlink(fp)
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return
      console.warn(`[sandbox] Failed to clear runtime override:`, err instanceof Error ? err.message : String(err))
    }
    return
  }
  // Atomic write: temp file + rename (FR-UI-006).
  const tmpPath = `${fp}.${process.pid}.${Date.now()}.tmp`
  await mkdir(path.dirname(fp), { recursive: true })
  await writeFile(tmpPath, JSON.stringify(config), "utf-8")
  try {
    await rename(tmpPath, fp)
  } catch {
    // Fallback: direct write if rename fails (e.g. cross-device)
    await writeFile(fp, JSON.stringify(config), "utf-8")
  }
}

export async function getRuntimeSandbox(): Promise<SandboxConfig | undefined> {
  try {
    const text = await readFile(filepath(), "utf-8")
    const parsed = JSON.parse(text) as Record<string, unknown>
    const sandbox = parsed?.profile !== undefined || parsed?.network !== undefined || parsed?.profiles !== undefined
      ? (parsed as SandboxConfig)
      : undefined
    return sandbox
  } catch (err) {
    // ENOENT is normal (no override set); other errors are diagnostic
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return
    console.warn(`[sandbox] Failed to read runtime override:`, err instanceof Error ? err.message : String(err))
    return undefined
  }
}

// Clear any stale runtime override from a previous session (S-SESS-1, FR-UI-006):
// runtime injection is session-scoped — restart must restore the layered merge result.
export async function clearRuntimeSandbox() {
  try {
    await unlink(filepath())
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return
    console.warn(`[sandbox] Failed to clear runtime override on bootstrap:`, err instanceof Error ? err.message : String(err))
  }
}
