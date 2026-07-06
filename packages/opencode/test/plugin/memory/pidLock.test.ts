import { expect, describe, it, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { createPidLock, isProcessRunning } from "../../../src/plugin/memory/util/pidLock"

describe("pidLock", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pidlock-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("isProcessRunning returns true for current process", () => {
    expect(isProcessRunning(process.pid)).toBe(true)
  })

  it("isProcessRunning returns false for non-existent PID", () => {
    // PID 99999999 is extremely unlikely to exist
    expect(isProcessRunning(99999999)).toBe(false)
  })

  it("acquire and release lock", async () => {
    const lock = createPidLock({ filename: ".test-lock", staleMs: 60_000 })
    const acquired = await lock.acquire(tmpDir)
    expect(acquired).toBe(true)

    // Lock file should exist
    const lockPath = lock.getLockPath(tmpDir)
    const content = JSON.parse(await fs.readFile(lockPath, "utf-8"))
    expect(content.pid).toBe(process.pid)
    expect(typeof content.mtime).toBe("number")

    // Release
    await lock.release(lockPath)
    await expect(fs.access(lockPath)).rejects.toThrow()
  })

  it("isLocked returns false when no lock exists", async () => {
    const lock = createPidLock({ filename: ".test-lock", staleMs: 60_000 })
    expect(await lock.isLocked(tmpDir)).toBe(false)
  })

  it("isLocked returns true when lock held by current process", async () => {
    const lock = createPidLock({ filename: ".test-lock", staleMs: 60_000 })
    await lock.acquire(tmpDir)
    expect(await lock.isLocked(tmpDir)).toBe(true)
  })

  it("stale lock is cleaned up", async () => {
    const lock = createPidLock({ filename: ".test-lock", staleMs: 1 }) // 1ms stale

    // Write a lock with old mtime
    const lockPath = lock.getLockPath(tmpDir)
    await fs.writeFile(lockPath, JSON.stringify({
      pid: 99999999, // non-existent process
      mtime: Date.now() - 100_000, // very old
    }))

    // isLocked should return false (stale + dead process)
    expect(await lock.isLocked(tmpDir)).toBe(false)

    // Should be able to acquire
    const acquired = await lock.acquire(tmpDir)
    expect(acquired).toBe(true)
  })

  it("acquireWithRollback returns prior mtime", async () => {
    const lock = createPidLock({ filename: ".test-lock", staleMs: 60_000 })

    // First acquisition
    const priorMtime = await lock.acquireWithRollback(tmpDir, "session-1")
    expect(priorMtime).toBe(0) // no prior lock

    // Release and re-acquire
    await lock.release(lock.getLockPath(tmpDir))
    const priorMtime2 = await lock.acquireWithRollback(tmpDir, "session-2")
    expect(typeof priorMtime2).toBe("number")
  })

  it("release is idempotent (no error on missing file)", async () => {
    const lock = createPidLock({ filename: ".test-lock", staleMs: 60_000 })
    const lockPath = lock.getLockPath(tmpDir)
    // Should not throw
    await lock.release(lockPath)
  })
})
