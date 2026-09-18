import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Memory from "../../src/util/memory"

const AUTO_MEMORY = Memory.SETTINGS[0]
const SKILLS = Memory.SETTINGS.find((item) => item.key === "skills.enabled") as Memory.Setting

async function scope() {
  const root = await mkdtemp(path.join(os.tmpdir(), "deveco-memory-"))
  return { home: path.join(root, "home"), directory: path.join(root, "project") }
}

describe("memory config", () => {
  test("falls back to plugin defaults and aliases", () => {
    expect(Memory.isEnabled({}, AUTO_MEMORY)).toBe(true)
    expect(Memory.isEnabled({}, SKILLS)).toBe(false)
    // The plugin reads a top-level `enabled` before `autoMemory.enabled`.
    expect(Memory.isEnabled({ enabled: false }, AUTO_MEMORY)).toBe(false)
    expect(Memory.isEnabled({ enabled: false, autoMemory: { enabled: true } }, AUTO_MEMORY)).toBe(true)
  })

  test("reads only the user file and toggles write back to it", async () => {
    const value = await scope()
    await mkdir(path.join(value.home, ".deveco"), { recursive: true })
    await mkdir(path.join(value.directory, ".deveco"), { recursive: true })
    await writeFile(
      path.join(value.home, ".deveco", "memory-config.json"),
      JSON.stringify({ skills: { enabled: true }, autoMemory: { expiry: { ttl: 1 } } }),
    )
    await writeFile(
      path.join(value.directory, ".deveco", "memory-config.json"),
      JSON.stringify({ skills: { enabled: false } }),
    )
    // A project-level memory config is no longer read.
    expect(Memory.isEnabled(await Memory.readConfig(value), SKILLS)).toBe(true)

    await Memory.writeSetting(value, SKILLS, false)

    expect(await Bun.file(path.join(value.directory, ".deveco", "memory-config.json")).json()).toEqual({
      skills: { enabled: false },
    })
    const user = await Bun.file(path.join(value.home, ".deveco", "memory-config.json")).json()
    expect(user).toEqual({ skills: { enabled: false }, autoMemory: { expiry: { ttl: 1 } } })
    expect(Memory.isEnabled(await Memory.readConfig(value), SKILLS)).toBe(false)
  })
})

describe("memory directory naming", () => {
  // Golden values from the memory plugin's getMemoryPath: separators become _, other unsafe
  // characters are dropped, the id is truncated to 64 chars and suffixed with a sha256 prefix.
  test("matches the plugin slug", () => {
    expect(Memory.slugify("/Users/dev/my project")).toBe("_Users_dev_myproject_5086e948293f")
    expect(Memory.slugify("/" + "a".repeat(200))).toBe("_" + "a".repeat(63) + "_f7b36aaa140c")
  })
})

describe("memory files", () => {
  test("lists parsed entries newest first and skips files the plugin ignores", async () => {
    const value = await scope()
    const dir = Memory.memoryDir({}, value)
    expect(dir).toBe(path.join(value.home, ".deveco", "memory", Memory.slugify(path.resolve(value.directory))))
    expect(Memory.memoryDir({ customMemoryDir: "/tmp/mem" }, value)).toBe("/tmp/mem")
    expect(Memory.memoryDir({ storageMode: "project" }, value)).toBe(path.join(value.directory, ".deveco", "memory"))

    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, "old.md"),
      '---\nname: old skill\ndescription: "line one\\nline two"\ntype: project\nupdated: 5000\n---\n\nbody text\n',
    )
    await writeFile(path.join(dir, "new.md"), "---\nname: new\ndescription: desc\ntype: feedback\n---\nnew body\n")
    await writeFile(path.join(dir, "MEMORY.md"), "---\nname: index\ndescription: index\ntype: project\n---\nskipped\n")
    await writeFile(path.join(dir, "broken.md"), "---\nname: no description\ntype: project\n---\nskipped\n")
    await utimes(path.join(dir, "old.md"), new Date(1000), new Date(1000))
    await utimes(path.join(dir, "new.md"), new Date(2000), new Date(2000))

    const items = await Memory.list(dir)
    // The frontmatter stamp beats the 1s file mtime, same rule the plugin uses.
    expect(items.map((item) => item.name)).toEqual(["old skill", "new"])
    expect(items[0].mtime).toBe(5000)
    expect(items[0].description).toBe("line one\nline two")

    const detail = await Memory.readItem(items[0].file)
    expect(detail?.header.type).toBe("project")
    expect(detail?.mtime).toBe(5000)
    expect(detail?.body).toContain("body text")

    // The dialog is not the only writer of that directory, so a vanished file is a value, not a throw.
    await rm(items[0].file, { force: true })
    expect(await Memory.readItem(items[0].file)).toBeUndefined()
  })
})

describe("memory deletion", () => {
  // Byte-for-byte the header the plugin's writeEntrypoint emits, so the rebuild can be asserted
  // exactly: any drift here means the TUI and the plugin index writers diverged.
  const CANONICAL_HEADER = [
    "# Project Memory Index",
    "",
    "This file serves as an index to all project memories.",
    "Memories are automatically loaded when relevant to the current context.",
    "",
    "## Memory Types",
    "",
    "- **user**: User preferences, role, and working style",
    "- **feedback**: Behavioral guidance (do's and don'ts)",
    "- **project**: Project context, goals, and technical decisions",
    "- **reference**: External resources and documentation",
    "",
    "## Memories",
    "",
  ]

  test("removing a memory rebuilds the index the way the plugin's updateEntrypoint does", async () => {
    const value = await scope()
    const dir = Memory.memoryDir({}, value)
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, "keep.md"),
      "---\nname: keep\ndescription: d\ntype: project\nupdated: 2000\n---\nkeep body\n",
    )
    await writeFile(
      path.join(dir, "drop.md"),
      "---\nname: drop\ndescription: d\ntype: feedback\nupdated: 1000\n---\ndrop body\n",
    )
    // No name in the frontmatter: the plugin's readFrontmatter drops it, so the rebuild must too.
    await writeFile(path.join(dir, "broken.md"), "---\ndescription: d\ntype: project\n---\nno name\n")
    // Drift the old index on purpose: hand-written header, ghost entry, manual note.
    await writeFile(
      path.join(dir, "MEMORY.md"),
      "# hand written index\n\n- [drop](drop.md) d\n- [ghost](ghost.md) d\nmanual note\n",
    )

    await Memory.remove(path.join(dir, "drop.md"))

    expect(await Bun.file(path.join(dir, "drop.md")).exists()).toBe(false)
    // Canonical template, broken file dropped, ghost and drift gone, trailing newline.
    expect(await Bun.file(path.join(dir, "MEMORY.md")).text()).toBe(
      CANONICAL_HEADER.concat(["- [keep](keep.md) d", ""]).join("\n"),
    )

    // Deleting a file that is already gone is not an error, same as the plugin's `rm -f`.
    await Memory.remove(path.join(dir, "drop.md"))
    expect(await Bun.file(path.join(dir, "keep.md")).exists()).toBe(true)
  })

  test("the rebuild honors the plugin's index limits from the config", async () => {
    const value = await scope()
    const dir = Memory.memoryDir({}, value)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "a.md"), "---\nname: a\ndescription: d\ntype: project\n---\nbody\n")

    // Same resolution order as the plugin: top-level, then autoMemory.*, then default.
    await Memory.remove(path.join(dir, "a.md"), { autoMemory: { maxEntrypointLines: 3 } })
    expect(await Bun.file(path.join(dir, "MEMORY.md")).text()).toBe(
      ["# Project Memory Index", "", "This file serves as an index to all project memories."].join("\n") + "\n",
    )

    await Memory.remove(path.join(dir, "a.md"), { maxEntrypointBytes: 30 })
    expect(await Bun.file(path.join(dir, "MEMORY.md")).text()).toBe("# Project Memory Index\n\n")
  })
})
