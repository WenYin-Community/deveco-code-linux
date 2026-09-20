import { expect, it } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MemoryStorage } from "../../../src/plugin/memory/memory/storage"
import { readPendingExpiryDetails } from "../../../src/plugin/memory/index"

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "memory-expiry-details-")))
  const storage = new MemoryStorage("test-project", root, { storageMode: "global", customMemoryDir: root })
  await storage.init()
  await storage.write({ name: "no-var", description: "Use const instead of var", type: "feedback", content: "Never declare with var, always const." })
  return { root, storage }
}

async function markPending(storage: MemoryStorage) {
  await storage.writePendingExpiry({
    pendingDeletions: [
      { name: "no-var", type: "feedback", mtime: 1, ageDays: 99, ttlDays: 0, reason: "expired" },
      { name: "gone", type: "project", mtime: 1, ageDays: 99, ttlDays: 0, reason: "expired" },
    ],
    generatedAt: 1,
    dreamSessionID: "ses_dream",
  })
}

it("renders every pending memory so the confirmation can be checked", async () => {
  const { root, storage } = await fixture()
  try {
    await markPending(storage)
    const details = await readPendingExpiryDetails(storage)
    // /memory detail format: numbered "Memory: {name}" heading, aligned frontmatter rows, body, file path
    expect(details).toContain("## 1. Memory: no-var")
    expect(details).toContain("~~description~~  Use const instead of var")
    expect(details).toContain("~~type~~         feedback")
    expect(details).toContain("~~created~~      ")
    expect(details).toContain("~~updated~~      ")
    expect(details).toContain("Never declare with var, always const.")
    expect(details).toContain(`~~${path.join(root, "no_var.md")}~~`)
    // no name row: the heading already carries it, same as the /memory detail view
    expect(details).not.toContain("~~name~~")
    expect(details).not.toContain("**metadata**")
    // one section per marked memory; an entry whose file is gone is dropped at the
    // readPendingExpiry choke point so it never inflates the count shown to the user
    expect(details).not.toContain("## Memory: gone")
    expect(details).not.toContain("(memory file missing or frontmatter invalid)")
    // no thematic-break line between sections: numbered headings mark boundaries instead
    expect(details).not.toContain("\n\n---\n\n")
    // a single section carries no sentinel
    expect(details).not.toContain("<!--memory-section-->")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("stays out of the way when nothing is pending", async () => {
  const { root, storage } = await fixture()
  try {
    expect(await readPendingExpiryDetails(storage)).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("numbers each file and separates sections by a blank line, not a rule", async () => {
  const { root, storage } = await fixture()
  try {
    await storage.write({ name: "no-var", description: "Use const instead of var", type: "feedback", content: "Never declare with var, always const." })
    await storage.write({ name: "slow-builds", description: "Skip tool-call narration", type: "feedback", content: "Do not explain tool calls." })
    await storage.writePendingExpiry({
      pendingDeletions: [
        { name: "no-var", type: "feedback", mtime: 1, ageDays: 99, ttlDays: 0, reason: "expired" },
        { name: "slow-builds", type: "feedback", mtime: 1, ageDays: 99, ttlDays: 0, reason: "expired" },
      ],
      generatedAt: 1,
      dreamSessionID: "ses_dream",
    })
    const details = await readPendingExpiryDetails(storage)
    expect(details).toContain("## 1. Memory: no-var")
    expect(details).toContain("## 2. Memory: slow-builds")
    // the TUI splits each file into its own framed block on this sentinel
    expect(details).toContain("<!--memory-section-->")
    expect(details).not.toContain("\n\n---\n\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
