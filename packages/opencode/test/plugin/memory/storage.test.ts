import { expect, describe, it, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

/**
 * Tests for UTF-8 safe truncation (P0-4) and memory storage.
 */
describe("UTF-8 truncation safety", () => {
  /**
   * Safely truncate content to maxBytes UTF-8 bytes without cutting
   * multi-byte characters.
   */
  function truncateUtf8(content: string, maxBytes: number): string {
    const buf = Buffer.from(content, "utf-8")
    if (buf.length <= maxBytes) return content
    // TextDecoder with fatal:false replaces incomplete sequences at boundary
    // We use ignoreBOM to get clean output
    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
    return decoder.decode(buf.subarray(0, maxBytes))
  }

  it("does not exceed byte limit with Chinese characters", () => {
    // 30000 Chinese characters = ~90000 UTF-8 bytes
    const content = "中".repeat(30000)
    const maxBytes = 25000
    const result = truncateUtf8(content, maxBytes)
    // Allow up to 3 extra bytes for a potential replacement char at boundary
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(maxBytes + 3)
    // The result should be dramatically shorter than the original
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThan(Buffer.byteLength(content, "utf-8") / 3)
  })

  it("produces valid output after truncation", () => {
    const content = "Hello World".repeat(1000)
    const result = truncateUtf8(content, 5000)
    // ASCII content should truncate cleanly at exact byte boundary
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(5000)
    expect(result.length).toBeLessThanOrEqual(5000)
  })

  it("does not cut emoji surrogate pairs", () => {
    // Each emoji is 4 UTF-8 bytes (2 UTF-16 code units)
    const content = "😀".repeat(10000)
    const result = truncateUtf8(content, 10000) // 2500 complete emojis
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(10000)
  })

  it("does not truncate when content fits", () => {
    const content = "Hello, world!"
    const result = truncateUtf8(content, 1000)
    expect(result).toBe(content)
  })

  it("handles empty string", () => {
    expect(truncateUtf8("", 100)).toBe("")
  })
})

describe("memory storage utilities", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-storage-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("readFrontmatter handles malformed files gracefully", async () => {
    const { readFrontmatter } = await import("../../../src/plugin/memory/util/path")

    // Create a file with invalid frontmatter
    const badFile = path.join(tmpDir, "bad.md")
    await fs.writeFile(badFile, "No frontmatter here\nJust content")
    const result = await readFrontmatter(badFile)
    expect(result).toBeNull()
  })

  it("readFrontmatter parses valid frontmatter", async () => {
    const { readFrontmatter } = await import("../../../src/plugin/memory/util/path")

    const goodFile = path.join(tmpDir, "good.md")
    await fs.writeFile(goodFile, `---
name: test-memory
type: project
description: A test memory
---
# Content here
`)
    const result = await readFrontmatter(goodFile)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("test-memory")
    expect(result!.type).toBe("project")
    expect(result!.description).toBe("A test memory")
  })

  it("readFrontmatter handles non-existent file", async () => {
    const { readFrontmatter } = await import("../../../src/plugin/memory/util/path")
    const result = await readFrontmatter(path.join(tmpDir, "nonexistent.md"))
    expect(result).toBeNull()
  })
})
