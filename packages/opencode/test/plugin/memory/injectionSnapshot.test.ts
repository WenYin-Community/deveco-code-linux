import { expect, describe, it, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import {
  SessionInjectionSnapshotCache,
  computeInjectionBlocks,
  type InjectionBlockInputs,
} from "../../../src/plugin/memory/memory/injectionSnapshot"
import { MemoryStorage } from "../../../src/plugin/memory/memory/storage"
import { MemoryInjection } from "../../../src/plugin/memory/memory/injection"
import { DEFAULT_MEMORY_CONFIG } from "../../../src/plugin/memory/memory/types"
import { SLASH_COMMANDS_GUIDANCE, SKILLS_GUIDANCE } from "../../../src/plugin/memory/skills/prompts"

function fakeInputs(overrides: Partial<InjectionBlockInputs["opts"]> = {}): InjectionBlockInputs {
  return {
    injection: {
      injectIndexOnly: async () => ({ systemPrompt: "MEMORY-BLOCK" }),
      inject: async () => ({ systemPrompt: "MEMORY-BLOCK-FULL" }),
    },
    skillInjection: {
      inject: async () => ({ systemPrompt: "SKILL-BLOCK" }),
    },
    opts: {
      truncationEnabled: true,
      skillsEnabled: false,
      slashCommandsEnabled: true,
      subMemoryRecall: false,
      subSkillReviewTrigger: false,
      isSubNow: false,
      ...overrides,
    },
  }
}

describe("SessionInjectionSnapshotCache", () => {
  it("stores and returns blocks per session", () => {
    const cache = new SessionInjectionSnapshotCache()
    cache.set("s1", ["a", "b"])
    expect(cache.get("s1")).toEqual(["a", "b"])
    expect(cache.get("s2")).toBeUndefined()
    expect(cache.size).toBe(1)
  })

  it("evicts the oldest entry once the cap is reached", () => {
    const cache = new SessionInjectionSnapshotCache(3)
    cache.set("a", ["1"])
    cache.set("b", ["2"])
    cache.set("c", ["3"])
    cache.set("d", ["4"])
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("b")).toEqual(["2"])
    expect(cache.get("d")).toEqual(["4"])
    expect(cache.size).toBe(3)
  })

  it("re-setting an existing session refreshes its FIFO position", () => {
    const cache = new SessionInjectionSnapshotCache(3)
    cache.set("a", ["1"])
    cache.set("b", ["2"])
    cache.set("c", ["3"])
    cache.set("a", ["1-updated"]) // move a to the back
    cache.set("d", ["4"])         // now b is the oldest
    expect(cache.get("a")).toEqual(["1-updated"])
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("d")).toEqual(["4"])
  })

  it("delete and clear remove entries", () => {
    const cache = new SessionInjectionSnapshotCache()
    cache.set("a", ["1"])
    cache.set("b", ["2"])
    cache.delete("a")
    expect(cache.get("a")).toBeUndefined()
    cache.clear()
    expect(cache.size).toBe(0)
  })
})

describe("computeInjectionBlocks", () => {
  it("assembles memory block then slash guidance for a main session", async () => {
    const { blocks, hadError } = await computeInjectionBlocks(fakeInputs())
    expect(hadError).toBe(false)
    expect(blocks).toEqual(["MEMORY-BLOCK", SLASH_COMMANDS_GUIDANCE])
  })

  it("appends skill block and skill guidance when skills are enabled", async () => {
    const { blocks, hadError } = await computeInjectionBlocks(fakeInputs({ skillsEnabled: true }))
    expect(hadError).toBe(false)
    expect(blocks).toEqual(["MEMORY-BLOCK", "SKILL-BLOCK", SKILLS_GUIDANCE, SLASH_COMMANDS_GUIDANCE])
  })

  it("uses the legacy full injection when truncation is disabled", async () => {
    const { blocks } = await computeInjectionBlocks(fakeInputs({ truncationEnabled: false }))
    expect(blocks[0]).toBe("MEMORY-BLOCK-FULL")
  })

  it("marks hadError and skips the memory block when the memory read throws", async () => {
    const inputs = fakeInputs()
    inputs.injection = {
      injectIndexOnly: async () => { throw new Error("disk boom") },
      inject: async () => { throw new Error("disk boom") },
    }
    const { blocks, hadError } = await computeInjectionBlocks(inputs)
    expect(hadError).toBe(true)
    expect(blocks).toEqual([SLASH_COMMANDS_GUIDANCE])
  })

  it("marks hadError when the skill read throws but keeps the other blocks", async () => {
    const inputs = fakeInputs({ skillsEnabled: true })
    inputs.skillInjection = {
      inject: async () => { throw new Error("skill boom") },
    }
    const { blocks, hadError } = await computeInjectionBlocks(inputs)
    expect(hadError).toBe(true)
    expect(blocks).toEqual(["MEMORY-BLOCK", SLASH_COMMANDS_GUIDANCE])
  })

  it("omits the memory block for subagent sessions unless memoryRecall is enabled", async () => {
    const gated = await computeInjectionBlocks(fakeInputs({ isSubNow: true }))
    expect(gated.blocks).toEqual([SLASH_COMMANDS_GUIDANCE])

    const recalled = await computeInjectionBlocks(fakeInputs({ isSubNow: true, subMemoryRecall: true }))
    expect(recalled.blocks[0]).toBe("MEMORY-BLOCK")
  })

  it("omits the skill block for subagent sessions unless skillReviewTrigger is enabled", async () => {
    const gated = await computeInjectionBlocks(fakeInputs({ isSubNow: true, skillsEnabled: true }))
    expect(gated.blocks).toEqual([SLASH_COMMANDS_GUIDANCE])

    const allowed = await computeInjectionBlocks(
      fakeInputs({ isSubNow: true, skillsEnabled: true, subSkillReviewTrigger: true }),
    )
    // subMemoryRecall stays false, so the memory block is still gated off
    expect(allowed.blocks).toEqual(["SKILL-BLOCK", SKILLS_GUIDANCE, SLASH_COMMANDS_GUIDANCE])
  })

  it("omits slash guidance when slash commands are disabled", async () => {
    const { blocks } = await computeInjectionBlocks(fakeInputs({ slashCommandsEnabled: false }))
    expect(blocks).toEqual(["MEMORY-BLOCK"])
  })
})

describe("injection snapshot freeze (real storage)", () => {
  let tmpDir: string
  let memDir: string
  let storage: MemoryStorage
  let injection: MemoryInjection
  const realDateNow = Date.now.bind(Date)

  // Patch Date.now directly (injectIndexOnly reads it for age tags). Avoid
  // bun's setSystemTime — a frozen clock leaks into the runner's own timers.
  function travelTo(ms: number): void {
    Date.now = () => ms
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-snapshot-test-"))
    memDir = path.join(tmpDir, "memory")
    const config = { ...DEFAULT_MEMORY_CONFIG, customMemoryDir: memDir }
    storage = new MemoryStorage("snapshot-test", tmpDir, config)
    await storage.init()
    injection = new MemoryInjection(storage, config)
  })

  afterEach(async () => {
    Date.now = realDateNow
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function opts(): InjectionBlockInputs["opts"] {
    return {
      truncationEnabled: true,
      skillsEnabled: false,
      slashCommandsEnabled: true,
      subMemoryRecall: false,
      subSkillReviewTrigger: false,
      isSubNow: false,
    }
  }

  it("frozen snapshot stays byte-identical across MEMORY.md changes and time drift", async () => {
    const T0 = new Date("2026-09-09T00:00:00Z").getTime()
    travelTo(T0)
    await storage.write({
      name: "first-memory",
      description: "original description",
      type: "project",
      created: T0,
      updated: T0,
      content: "some content",
    })

    // First request of session A: render + freeze
    const cache = new SessionInjectionSnapshotCache()
    const first = await computeInjectionBlocks({ injection, skillInjection: { inject: async () => ({}) }, opts: opts() })
    expect(first.hadError).toBe(false)
    cache.set("session-A", first.blocks)

    // Mid-session: time drifts 2 days (age tags would change) and MEMORY.md gains an entry
    travelTo(new Date("2026-09-11T00:00:00Z").getTime())
    await storage.write({
      name: "second-memory",
      description: "added later",
      type: "project",
      created: Date.now(),
      updated: Date.now(),
      content: "more content",
    })

    // Cached session A must be byte-identical
    expect(cache.get("session-A")).toEqual(first.blocks)

    // Negative control: a fresh render (new session B) DOES pick up the drift —
    // proves the freeze comes from the snapshot, not from stale storage.
    const fresh = await computeInjectionBlocks({ injection, skillInjection: { inject: async () => ({}) }, opts: opts() })
    expect(fresh.hadError).toBe(false)
    expect(fresh.blocks.join("\n")).not.toBe(first.blocks.join("\n"))
    expect(fresh.blocks[0]).toContain("second-memory")
    expect(fresh.blocks[0]).toContain("(2d old)")

    // Session B gets its own frozen copy
    cache.set("session-B", fresh.blocks)
    expect(cache.get("session-B")).toEqual(fresh.blocks)
  })

  it("startup refresh: an evicted/deleted session re-renders from live state", async () => {
    const T0 = new Date("2026-09-09T00:00:00Z").getTime()
    travelTo(T0)
    await storage.write({
      name: "only-memory",
      description: "desc",
      type: "project",
      created: T0,
      updated: T0,
      content: "content",
    })

    const cache = new SessionInjectionSnapshotCache()
    const first = await computeInjectionBlocks({ injection, skillInjection: { inject: async () => ({}) }, opts: opts() })
    cache.set("session-X", first.blocks)

    // Session deleted (or FIFO-evicted) → next request renders fresh
    cache.delete("session-X")
    expect(cache.get("session-X")).toBeUndefined()

    const reRendered = await computeInjectionBlocks({ injection, skillInjection: { inject: async () => ({}) }, opts: opts() })
    expect(reRendered.blocks).toEqual(first.blocks)
  })
})
