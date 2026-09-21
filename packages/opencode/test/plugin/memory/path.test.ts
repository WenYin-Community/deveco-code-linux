import { expect, describe, it } from "bun:test"
import path from "path"
import os from "os"
import {
  getMemoryPath,
  getGlobalDataDir,
  ENTRYPOINT_NAME,
  MEMORY_DIR_NAME,
} from "../../../src/plugin/memory/util/path"

describe("getGlobalDataDir", () => {
  it("returns ~/.deveco", () => {
    const dir = getGlobalDataDir()
    expect(dir).toBe(path.join(os.homedir(), '.deveco'))
  })
})

describe("getMemoryPath", () => {
  it("global mode uses ~/.deveco", () => {
    const memPath = getMemoryPath("/home/user/project", "/home/user/project", "global")
    expect(memPath).toContain(path.join(os.homedir(), '.deveco'))
    expect(memPath).toContain(MEMORY_DIR_NAME)
  })

  it("project mode uses .deveco", () => {
    const memPath = getMemoryPath("test", "/home/user/project", "project")
    expect(memPath).toContain(".deveco")
    expect(memPath).toContain(MEMORY_DIR_NAME)
  })

  it("custom dir overrides everything", () => {
    const memPath = getMemoryPath("test", "/home/user/project", "global", "/custom/path")
    expect(memPath).toBe("/custom/path")
  })
})

describe("LOCK_FILE_NAMES", () => {
  it("exports expected lock file names", async () => {
    const { LOCK_FILE_NAMES } = await import("../../../src/plugin/memory/util/forkManager")
    expect(LOCK_FILE_NAMES).toContain(".extraction-lock")
    expect(LOCK_FILE_NAMES).toContain(".consolidate-lock")
    expect(LOCK_FILE_NAMES).toContain(".skill-review-lock")
    expect(LOCK_FILE_NAMES).toContain(".auto-dream-state.json")
    expect(LOCK_FILE_NAMES).toContain(".pending-expiry.json")
    expect(LOCK_FILE_NAMES).toHaveLength(5)
  })

  it("basename matching rejects substring matches (P0-3)", async () => {
    const { LOCK_FILE_NAMES } = await import("../../../src/plugin/memory/util/forkManager")
    // This file name contains ".consolidate-lock" as a substring but is NOT a lock file
    const fakeFile = "notes-on-.consolidate-lock-behavior.md"
    const baseName = fakeFile.split(/[/\\]/).pop() || ""
    const isLockFile = LOCK_FILE_NAMES.includes(baseName as typeof LOCK_FILE_NAMES[number])
    expect(isLockFile).toBe(false)
  })

  it("basename matching accepts actual lock files (P0-3)", async () => {
    const { LOCK_FILE_NAMES } = await import("../../../src/plugin/memory/util/forkManager")
    const realFile = "/home/user/.deveco/memory/abc123/.consolidate-lock"
    const baseName = realFile.split(/[/\\]/).pop() || ""
    const isLockFile = LOCK_FILE_NAMES.includes(baseName as typeof LOCK_FILE_NAMES[number])
    expect(isLockFile).toBe(true)
  })
})
