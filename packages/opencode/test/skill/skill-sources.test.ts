import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  digestSkill,
  digestSkills,
  loadResourceSkills,
  readSkillFile,
  validateSkills,
  walkSkillDir,
  type SkillsData,
} from "../../script/skill-sources"

const packageDir = path.resolve(import.meta.dir, "../..")

async function writeSkill(root: string, name: string, files: Record<string, string | Uint8Array>) {
  const skillDir = path.join(root, name)
  await fs.promises.mkdir(skillDir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(skillDir, file)
    await fs.promises.mkdir(path.dirname(full), { recursive: true })
    await fs.promises.writeFile(full, content)
  }
}

async function tempRoot(prefix: string) {
  return await fs.promises.mkdtemp(path.join(process.env.TEMP ?? "/tmp", prefix))
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected the promise to reject")
}

describe("walkSkillDir", () => {
  test("encodes binary assets as base64 and skips .DS_Store", async () => {
    const dir = await tempRoot("skill-sources-walk-")
    try {
      const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff, 0xfe])
      await writeSkill(dir, "demo", {
        "SKILL.md": "---\nname: demo\ndescription: x\n---\n",
        "lib/mappings.wasm": wasm,
        ".DS_Store": "junk",
      })
      const files = await walkSkillDir(path.join(dir, "demo"))
      expect(Object.keys(files).sort()).toEqual(["SKILL.md", "lib/mappings.wasm"])
      expect(files["lib/mappings.wasm"]).toEqual({ encoding: "base64", content: Buffer.from(wasm).toString("base64") })
      expect(typeof files["SKILL.md"]).toBe("string")
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })

  test("readSkillFile keeps wasm bytes intact", async () => {
    const dir = await tempRoot("skill-sources-read-")
    try {
      const bytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xc0, 0x80])
      const file = path.join(dir, "mappings.wasm")
      await fs.promises.writeFile(file, bytes)
      const embedded = await readSkillFile(file)
      expect(embedded).toEqual({ encoding: "base64", content: bytes.toString("base64") })
      if (typeof embedded === "string") throw new Error("expected base64")
      const decoded = Buffer.from(embedded.content, "base64")
      expect(decoded.equals(bytes)).toBe(true)
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("digestSkills", () => {
  test("is stable regardless of key order", () => {
    const a: SkillsData = { x: { "a.md": "1", "b.md": "2" }, y: { "SKILL.md": "3" } }
    const b: SkillsData = { y: { "SKILL.md": "3" }, x: { "b.md": "2", "a.md": "1" } }
    expect(digestSkills(a)).toBe(digestSkills(b))
    expect(digestSkills(a)).toMatch(/^[0-9a-f]{16}$/)
  })

  test("changes when any file content changes", () => {
    const base: SkillsData = { x: { "SKILL.md": "one" } }
    const changed: SkillsData = { x: { "SKILL.md": "two" } }
    expect(digestSkills(base)).not.toBe(digestSkills(changed))
    expect(digestSkill(base.x)).not.toBe(digestSkill(changed.x))
  })
})

describe("validateSkills", () => {
  test("accepts a well-formed skill", () => {
    const data: SkillsData = { demo: { "SKILL.md": "---\nname: demo\ndescription: x\n---\nbody\n" } }
    expect(validateSkills(data, ["demo"])).toEqual([])
  })

  test("reports missing required skills", () => {
    expect(validateSkills({}, ["demo"])).toEqual(['missing required skill "demo"'])
  })

  test("reports a frontmatter name mismatch", () => {
    const data: SkillsData = { demo: { "SKILL.md": "---\nname: other\ndescription: x\n---\n" } }
    expect(validateSkills(data).join("\n")).toContain('declares frontmatter name "other"')
  })

  test("reports a missing SKILL.md", () => {
    expect(validateSkills({ demo: { "README.md": "x" } }).join("\n")).toContain("no readable SKILL.md")
  })

  test("reports unsafe paths", () => {
    const data: SkillsData = {
      demo: { "SKILL.md": "---\nname: demo\ndescription: x\n---\n", "../escape.md": "x", "/abs.md": "x" },
    }
    const problems = validateSkills(data).join("\n")
    expect(problems).toContain('unsafe path "../escape.md"')
    expect(problems).toContain('unsafe path "/abs.md"')
  })

  test("accepts an overlay that lands on a built-in skill", () => {
    const data: SkillsData = { demo: { "SKILL.md": "---\nname: demo\ndescription: x\n---\n" } }
    expect(validateSkills(data, ["demo"], { demo: { "FILES.md": "a.md" } })).toEqual([])
  })

  test("reports an overlay that matches no skill", () => {
    expect(validateSkills({}, [], { ghost: { "FILES.md": "a.md" } })).toEqual([
      'overlay "ghost" matches no built-in skill',
    ])
  })

  test("reports an overlay that carries its own SKILL.md", () => {
    const data: SkillsData = { demo: { "SKILL.md": "---\nname: demo\ndescription: x\n---\n" } }
    const problems = validateSkills(data, [], { demo: { "SKILL.md": "hijacked" } }).join("\n")
    expect(problems).toContain('overlay "demo" must not carry SKILL.md')
  })

  test("reports an overlay that carries a nested SKILL.md", () => {
    const data: SkillsData = { demo: { "SKILL.md": "---\nname: demo\ndescription: x\n---\n" } }
    const problems = validateSkills(data, [], { demo: { "references/SKILL.md": "nested" } }).join("\n")
    expect(problems).toContain('overlay "demo" must not carry SKILL.md')
  })

  test("reports an empty and an unsafe overlay", () => {
    const data: SkillsData = { demo: { "SKILL.md": "---\nname: demo\ndescription: x\n---\n" } }
    const problems = validateSkills(data, [], { demo: { "../escape.md": "x" } }).join("\n")
    expect(problems).toContain('overlay "demo" contains unsafe path "../escape.md"')
    const empty = validateSkills(data, [], { demo: {} }).join("\n")
    expect(empty).toContain('overlay "demo" is empty')
  })
})

describe("loadResourceSkills", () => {
  test("reads the repository skills that remain local", async () => {
    const data = await loadResourceSkills(path.join(packageDir, "resources/skills"))
    expect(data["deveco-cli"]).toBeUndefined()
    expect(data["ui-verification-with-deeplink"]).toBeUndefined()
    expect(validateSkills(data)).toEqual([])
    expect(data["customize-deveco"]?.["SKILL.md"]).toBeString()
    expect(data["hmos-design-to-arkts"]?.["SKILL.md"]).toBeString()
  })

  test("returns an empty map when the directory is absent", async () => {
    expect(await loadResourceSkills(path.join(packageDir, "resources/does-not-exist"))).toEqual({})
  })
})
