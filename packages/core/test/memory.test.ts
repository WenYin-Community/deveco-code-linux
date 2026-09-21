import { expect, describe, it } from "bun:test"
import path from "path"
import os from "os"
import {
  slugifyProjectID,
  computeLegacyHash,
  normalizeProjectPath,
  getGlobalDataDir,
  getEntrypointPath,
  memoryNameToFilename,
  parseFrontmatter,
  serializeFrontmatter,
  createMemoryContent,
  formatMemoryIndexEntry,
  formatMemoryManifest,
  isMemoryFile,
  buildMemoryIndexContent,
  truncateMemoryIndexContent,
  ENTRYPOINT_NAME,
  MEMORY_DIR_NAME,
  type MemoryFrontmatter,
} from "@opencode-ai/core/memory"

describe("slugifyProjectID", () => {
  it("produces consistent output", () => {
    const slug1 = slugifyProjectID("/home/user/my-project")
    const slug2 = slugifyProjectID("/home/user/my-project")
    expect(slug1).toBe(slug2)
  })

  it("produces different output for different paths", () => {
    const slug1 = slugifyProjectID("/home/user/project-a")
    const slug2 = slugifyProjectID("/home/user/project-b")
    expect(slug1).not.toBe(slug2)
  })

  it("matches computeLegacyHash for backslash-normalized input", () => {
    const raw = "C:\\Users\\test\\project"
    const normalized = raw.replace(/\\/g, "/")
    expect(slugifyProjectID(normalized)).toBe(computeLegacyHash(raw))
  })
})

describe("normalizeProjectPath", () => {
  it("resolves and normalizes backslashes", () => {
    const result = normalizeProjectPath("/home/user/../user/project")
    expect(result).not.toContain("..")
  })

  it("preserves 'default'", () => {
    expect(normalizeProjectPath("default")).toBe("default")
  })
})

describe("getGlobalDataDir", () => {
  it("returns ~/.deveco", () => {
    expect(getGlobalDataDir()).toBe(path.join(os.homedir(), ".deveco"))
  })
})

describe("getEntrypointPath", () => {
  it("joins memoryPath with MEMORY.md", () => {
    expect(getEntrypointPath("/foo/bar")).toBe(path.join("/foo/bar", ENTRYPOINT_NAME))
  })
})

describe("memoryNameToFilename", () => {
  it("lowercases and sanitizes", () => {
    expect(memoryNameToFilename("My Memory!")).toBe("my_memory.md")
  })

  it("trims leading/trailing underscores", () => {
    expect(memoryNameToFilename("  hello  ")).toBe("hello.md")
  })
})

describe("parseFrontmatter", () => {
  it("parses a valid frontmatter block", () => {
    const content = [
      "---",
      'name: "test memory"',
      'description: "a test"',
      "type: user",
      "created: 1000",
      "updated: 2000",
      "pin: true",
      "ttl: 30",
      "---",
      "",
      "body text",
    ].join("\n")
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).not.toBeNull()
    expect(frontmatter!.name).toBe("test memory")
    expect(frontmatter!.description).toBe("a test")
    expect(frontmatter!.type).toBe("user")
    expect(frontmatter!.created).toBe(1000)
    expect(frontmatter!.updated).toBe(2000)
    expect(frontmatter!.pin).toBe(true)
    expect(frontmatter!.ttl).toBe(30)
    expect(body).toContain("body text")
  })

  it("returns null frontmatter when required fields missing", () => {
    const content = "---\nname: \"only name\"\n---\nbody"
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toBeNull()
    expect(body).toBe(content)
  })

  it("returns null frontmatter when no frontmatter block", () => {
    const content = "just some text"
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toBeNull()
    expect(body).toBe(content)
  })

  it("handles single-quoted values", () => {
    const content = "---\nname: 'single'\ndescription: 'quoted'\ntype: project\n---\nbody"
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter!.name).toBe("single")
    expect(frontmatter!.description).toBe("quoted")
  })

  it("unescapes quoted newline and quote sequences", () => {
    const content = "---\nname: \"line\\nbreak\"\ndescription: \"quote\\\"here\"\ntype: user\n---\nbody"
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter!.name).toBe("line\nbreak")
    expect(frontmatter!.description).toBe('quote"here')
  })

  it("parses boolean values case-insensitively", () => {
    const content = "---\nname: \"n\"\ndescription: \"d\"\ntype: user\npin: True\n---\nbody"
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter!.pin).toBe(true)
  })
})

describe("serializeFrontmatter / createMemoryContent round-trip", () => {
  it("round-trips a frontmatter through serialize then parse", () => {
    const fm: MemoryFrontmatter = {
      name: "round trip",
      description: 'has "quotes" and newlines',
      type: "feedback",
      created: 1234,
      updated: 5678,
      pin: true,
      ttl: 90,
    }
    const content = createMemoryContent(fm, "body text")
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter).toEqual(fm)
  })

  it("round-trips a description with an embedded newline", () => {
    const fm: MemoryFrontmatter = {
      name: "nl",
      description: "line one\nline two",
      type: "user",
    }
    const content = createMemoryContent(fm, "body")
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter).toEqual(fm)
  })

  it("omits optional fields when undefined", () => {
    const fm: MemoryFrontmatter = {
      name: "minimal",
      description: "desc",
      type: "project",
    }
    const content = serializeFrontmatter(fm)
    expect(content).not.toContain("created")
    expect(content).not.toContain("updated")
    expect(content).not.toContain("pin")
    expect(content).not.toContain("ttl")
  })
})

describe("isMemoryFile", () => {
  it("accepts regular .md files", () => {
    expect(isMemoryFile("memory.md")).toBe(true)
    expect(isMemoryFile("/path/to/memory.md")).toBe(true)
  })

  it("rejects MEMORY.md entrypoint", () => {
    expect(isMemoryFile("MEMORY.md")).toBe(false)
    expect(isMemoryFile("/path/MEMORY.md")).toBe(false)
  })

  it("rejects dotfiles", () => {
    expect(isMemoryFile(".hidden.md")).toBe(false)
  })

  it("rejects non-md files", () => {
    expect(isMemoryFile("file.txt")).toBe(false)
  })
})

describe("formatMemoryIndexEntry", () => {
  it("formats with basename of filepath", () => {
    const entry = formatMemoryIndexEntry({
      name: "test",
      description: "desc",
      type: "user",
      filepath: "/foo/bar/test.md",
    })
    expect(entry).toBe("- [test](test.md) desc")
  })

  it("handles missing filepath", () => {
    const entry = formatMemoryIndexEntry({
      name: "test",
      description: "desc",
      type: "user",
    })
    expect(entry).toBe("- [test]() desc")
  })
})

describe("formatMemoryManifest", () => {
  it("formats headers with type, time, name, description", () => {
    const manifest = formatMemoryManifest([
      { name: "a", description: "desc a", type: "user", mtime: 1700000000000 },
    ])
    expect(manifest).toContain("[USER]")
    expect(manifest).toContain("a")
    expect(manifest).toContain("desc a")
  })
})

describe("buildMemoryIndexContent", () => {
  it("produces the expected header and entries", () => {
    const content = buildMemoryIndexContent([
      { name: "test", filename: "test.md", description: "desc", type: "user" },
    ])
    expect(content).toContain("# Project Memory Index")
    expect(content).toContain("## Memory Types")
    expect(content).toContain("## Memories")
    expect(content).toContain("- [test](test.md) desc")
  })
})

describe("truncateMemoryIndexContent", () => {
  it("truncates by line count", () => {
    const content = "a\nb\nc\nd"
    const truncated = truncateMemoryIndexContent(content, 2, 1000)
    expect(truncated).toBe("a\nb")
  })

  it("truncates by byte count at line boundary", () => {
    const content = "aaaa\nbbbb\ncccc"
    const truncated = truncateMemoryIndexContent(content, 100, 10)
    expect(truncated.split("\n")).toContain("aaaa")
    expect(truncated).not.toContain("cccc")
  })

  it("preserves content under limits", () => {
    const content = "a\nb"
    const truncated = truncateMemoryIndexContent(content, 100, 1000)
    expect(truncated).toBe("a\nb")
  })
})
