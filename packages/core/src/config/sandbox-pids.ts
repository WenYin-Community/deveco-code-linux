import { Global } from "../global"
import path from "node:path"
import { readFile, writeFile, unlink, rename, mkdir, readdir } from "node:fs/promises"

// FR-EXEC-006: Persist sandbox-exec PIDs so that a crashed/killed host can
// clean up orphaned controlled processes on next bootstrap.
//
// Each deveco process writes its own file (<pid>.json) under sandbox-pids/,
// so that a new bootstrap can distinguish orphaned processes (owner dead)
// from processes owned by a still-running deveco instance.

const DIRNAME = "sandbox-pids"

function dir(): string {
  return path.join(Global.Path.data, DIRNAME)
}

function ownFile(): string {
  return path.join(dir(), `${process.pid}.json`)
}

// PIDs spawned by this process, kept in memory to avoid read-modify-write
// races with other deveco instances.
const owned = new Set<number>()

/** Add a sandbox-exec PID to this process's persistent list. Called after spawn. */
export async function addSandboxPid(pid: number) {
  owned.add(pid)
  await writePids(ownFile(), [...owned])
}

/** Remove a sandbox-exec PID from this process's persistent list. Called after graceful exit. */
export async function removeSandboxPid(pid: number) {
  owned.delete(pid)
  await writePids(ownFile(), [...owned])
}

/**
 * Clear stale sandbox-exec PIDs on bootstrap (FR-EXEC-006).
 * Only kills processes whose owner (deveco process) has already exited;
 * processes owned by still-running deveco instances are left alone.
 */
export async function clearStaleSandboxPids(
  killDescendants: (pid: number) => Promise<number[]>,
): Promise<void> {
  const files = await readdir(dir()).catch(() => [] as string[])
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    const owner = Number.parseInt(file.slice(0, -5), 10)
    if (!Number.isFinite(owner)) continue
    if (isAlive(owner)) continue
    await clearOrphanedPids(path.join(dir(), file), killDescendants)
    try { await unlink(path.join(dir(), file)) } catch {}
  }
}

async function clearOrphanedPids(
  filepath: string,
  killDescendants: (pid: number) => Promise<number[]>,
) {
  const pids = await readPids(filepath)
  for (const pid of pids) {
    if (!isAlive(pid)) continue
    await killPidAndDescendants(pid, killDescendants)
  }
}

async function killPidAndDescendants(
  pid: number,
  killDescendants: (pid: number) => Promise<number[]>,
) {
  const descendantPids = await killDescendants(pid).catch(() => [] as number[])
  for (const dpid of descendantPids) {
    try { process.kill(dpid, "SIGTERM") } catch {}
  }
  try { process.kill(pid, "SIGTERM") } catch {}
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readPids(filepath: string): Promise<number[]> {
  try {
    const text = await readFile(filepath, "utf-8")
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "number") : []
  } catch {
    return []
  }
}

async function writePids(filepath: string, pids: number[]) {
  await mkdir(path.dirname(filepath), { recursive: true })
  // Atomic write: temp file + rename
  const tmpPath = `${filepath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, JSON.stringify(pids), "utf-8")
  try {
    await rename(tmpPath, filepath)
  } catch {
    await writeFile(filepath, JSON.stringify(pids), "utf-8")
    try { await unlink(tmpPath) } catch {}
  }
}
