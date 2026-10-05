import { Global } from "../global"
import path from "node:path"
import { readFile, writeFile, unlink, rename, mkdir } from "node:fs/promises"

// FR-EXEC-006: Persist sandbox-exec PIDs so that a crashed/killed host can
// clean up orphaned controlled processes on next bootstrap. The file stores
// a JSON array of PIDs that were spawned but not yet gracefully terminated.

const FILENAME = "sandbox-pids.json"

function filepath(): string {
  return path.join(Global.Path.data, FILENAME)
}

/** Add a sandbox-exec PID to the persistent list. Called after spawn. */
export async function addSandboxPid(pid: number) {
  const pids = await readSandboxPids()
  if (!pids.includes(pid)) pids.push(pid)
  await writeSandboxPids(pids)
}

/** Remove a sandbox-exec PID from the persistent list. Called after graceful exit. */
export async function removeSandboxPid(pid: number) {
  const pids = await readSandboxPids()
  const filtered = pids.filter((p) => p !== pid)
  await writeSandboxPids(filtered)
}

/** Read all persisted sandbox-exec PIDs. Returns [] on error or missing file. */
export async function readSandboxPids(): Promise<number[]> {
  try {
    const text = await readFile(filepath(), "utf-8")
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "number") : []
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return []
    console.warn(`[sandbox] Failed to read sandbox-pids:`, err instanceof Error ? err.message : String(err))
    return []
  }
}

async function writeSandboxPids(pids: number[]) {
  const fp = filepath()
  await mkdir(path.dirname(fp), { recursive: true })
  // Atomic write: temp file + rename
  const tmpPath = `${fp}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, JSON.stringify(pids), "utf-8")
  try {
    await rename(tmpPath, fp)
  } catch {
    await writeFile(fp, JSON.stringify(pids), "utf-8")
  }
}

/**
 * Clear stale sandbox-exec PIDs on bootstrap (FR-EXEC-006).
 * Kills any still-running processes and their descendants, then removes the file.
 * Should be called at startup before any new sandbox commands are issued.
 */
export async function clearStaleSandboxPids(
  killDescendants: (pid: number) => Promise<number[]>,
): Promise<void> {
  const pids = await readSandboxPids()
  for (const pid of pids) {
    try {
      process.kill(pid, 0) // Check if still alive
    } catch {
      continue // Already dead — skip
    }
    // Kill descendants first, then the root
    const descendantPids = await killDescendants(pid).catch(() => [] as number[])
    for (const dpid of descendantPids) {
      try { process.kill(dpid, "SIGTERM") } catch {}
    }
    try { process.kill(pid, "SIGTERM") } catch {}
  }
  // Remove the file regardless — surviving processes will be reaped by OS
  try {
    await unlink(filepath())
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return
  }
}
