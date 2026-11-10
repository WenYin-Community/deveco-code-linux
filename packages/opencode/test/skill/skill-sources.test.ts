import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  CLI_BUNDLED_SKILLS,
  digestSkill,
  digestSkills,
  loadCliSkills,
  loadResourceSkills,
  mergeSkills,
  REPO_OWNED_SKILLS,
  readSkillFile,
  resolveCliCommonPackageJson,
  resolveCliSkillsRoot,
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

describe("CLI_BUNDLED_SKILLS", () => {
  test("covers every skill the code requires by name", async () => {
    // DevEcoRequiredSkills is a subset: only skills that need DEVECO_HOME are listed.
    const tool = await fs.promises.readFile(path.join(packageDir, "src/tool/skill.ts"), "utf8")
    const required = tool.slice(tool.indexOf("DevEcoRequiredSkills"), tool.indexOf("])", tool.indexOf("DevEcoRequiredSkills")))
    const names = [...required.matchAll(/"([^"]+)"/g)].map((match) => match[1])
    expect(names.length).toBeGreaterThan(0)

    // Subagent skill permissions are the other place a bundled skill is referenced
    // by name (the dfx agent exposes hmos-dfx-analyzer).
    const agents = await fs.promises.readFile(path.join(packageDir, "src/agent/agent.ts"), "utf8")
    const permitted = [...agents.matchAll(/"(hmos-[a-z0-9-]+)"\s*:\s*"allow"/g)].map((match) => match[1])
    expect(permitted.length).toBeGreaterThan(0)

    const bundled: readonly string[] = CLI_BUNDLED_SKILLS
    for (const name of names) {
      expect(bundled).toContain(name)
    }
    for (const name of permitted) {
      expect(bundled).toContain(name)
    }
  })

  test("no bundled skill still lives in resources/skills", () => {
    for (const name of CLI_BUNDLED_SKILLS) {
      expect(fs.existsSync(path.join(packageDir, "resources/skills", name))).toBe(false)
    }
  })
})

describe("resolveCliCommonPackageJson", () => {
  test("resolves the implementation package from the installed shell", () => {
    const manifest = resolveCliCommonPackageJson(packageDir)
    if (!manifest) {
      // The pinned CLI release predates the -common package; nothing to assert.
      return
    }
    expect(manifest.endsWith(path.join("deveco-cli-common", "package.json"))).toBe(true)
  })

  test("returns undefined when nothing is installed", async () => {
    const dir = await tempRoot("skill-sources-none-")
    try {
      expect(resolveCliCommonPackageJson(dir)).toBeUndefined()
      expect(resolveCliSkillsRoot(dir)).toBeUndefined()
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })

  test("finds a pre-release build published under the test scope", async () => {
    const dir = await tempRoot("skill-sources-testscope-")
    try {
      const common = path.join(dir, "node_modules", "@deveco-test", "deveco-cli-common")
      await fs.promises.mkdir(path.join(common, "skills"), { recursive: true })
      await fs.promises.writeFile(
        path.join(common, "package.json"),
        JSON.stringify({ name: "@deveco-test/deveco-cli-common", version: "2.0.0-Test.1" }),
      )
      await fs.promises.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ dependencies: { "@deveco-test/deveco-cli": "2.0.0-Test.1" } }),
      )

      const manifest = resolveCliCommonPackageJson(dir)
      expect(manifest).toBeDefined()
      expect(manifest).toContain(path.join("@deveco-test", "deveco-cli-common"))

      const loaded = await loadCliSkills(dir, [])
      expect(loaded.packageName).toBe("@deveco-test/deveco-cli-common")
      expect(loaded.version).toBe("2.0.0-Test.1")
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })

  test("prefers the scope pinned in package.json", async () => {
    const dir = await tempRoot("skill-sources-pinned-")
    try {
      for (const scope of ["@deveco", "@deveco-test"]) {
        const common = path.join(dir, "node_modules", scope, "deveco-cli-common")
        await fs.promises.mkdir(path.join(common, "skills"), { recursive: true })
        await fs.promises.writeFile(
          path.join(common, "package.json"),
          JSON.stringify({ name: `${scope}/deveco-cli-common`, version: `${scope}@1.0.0` }),
        )
      }
      await fs.promises.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ dependencies: { "@deveco/deveco-cli": "1.0.0" } }),
      )
      expect((await loadCliSkills(dir, [])).packageName).toBe("@deveco/deveco-cli-common")
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })

  test("resolves the real -common package through an npm alias pin", async () => {
    const dir = await tempRoot("skill-sources-alias-")
    try {
      // The dependency key keeps @deveco/, but the installed package's own `name`
      // is the @deveco-test shell and its -common is nested beneath it (bun's
      // isolated linker). The resolver must follow the real name, not the alias key.
      await fs.promises.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ dependencies: { "@deveco/deveco-cli": "npm:@deveco-test/deveco-cli@1.3.11-Test.4" } }),
      )
      const shell = path.join(dir, "node_modules", "@deveco", "deveco-cli")
      await fs.promises.mkdir(shell, { recursive: true })
      await fs.promises.writeFile(
        path.join(shell, "package.json"),
        JSON.stringify({ name: "@deveco-test/deveco-cli", version: "1.3.11-Test.4" }),
      )
      const common = path.join(shell, "node_modules", "@deveco-test", "deveco-cli-common")
      await fs.promises.mkdir(path.join(common, "skills"), { recursive: true })
      await fs.promises.writeFile(
        path.join(common, "package.json"),
        JSON.stringify({ name: "@deveco-test/deveco-cli-common", version: "1.3.11-Test.4" }),
      )

      const manifest = resolveCliCommonPackageJson(dir)
      expect(manifest).toBeDefined()
      expect(manifest).toContain(path.join("@deveco-test", "deveco-cli-common"))
      expect((await loadCliSkills(dir, [])).packageName).toBe("@deveco-test/deveco-cli-common")
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("loadCliSkills", () => {
  test("fails loudly when the CLI package is missing", async () => {
    const dir = await tempRoot("skill-sources-missing-")
    try {
      expect(await rejection(loadCliSkills(dir))).toContain("deveco-cli-common not found")
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })

  test("fails loudly when a whitelisted skill is missing", async () => {
    const dir = await tempRoot("skill-sources-partial-")
    try {
      const common = path.join(dir, "node_modules", "@deveco", "deveco-cli-common")
      await fs.promises.mkdir(path.join(common, "skills"), { recursive: true })
      await fs.promises.writeFile(
        path.join(common, "package.json"),
        JSON.stringify({ name: "@deveco/deveco-cli-common", version: "9.9.9" }),
      )
      await writeSkill(path.join(common, "skills"), "hmos-arkui-develop-skill", {
        "SKILL.md": "---\nname: hmos-arkui-develop-skill\ndescription: x\n---\n",
      })
      expect(await rejection(loadCliSkills(dir))).toContain('Bundled skill "hmos-dfx-analyzer" is missing')
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })

  test("ignores skill directories outside the whitelist", async () => {
    const dir = await tempRoot("skill-sources-extra-")
    try {
      const common = path.join(dir, "node_modules", "@deveco", "deveco-cli-common")
      const skills = path.join(common, "skills")
      await fs.promises.mkdir(skills, { recursive: true })
      await fs.promises.writeFile(
        path.join(common, "package.json"),
        JSON.stringify({ name: "@deveco/deveco-cli-common", version: "9.9.9" }),
      )
      for (const name of CLI_BUNDLED_SKILLS) {
        await writeSkill(skills, name, { "SKILL.md": `---\nname: ${name}\ndescription: x\n---\n` })
      }
      await writeSkill(skills, "not-whitelisted", { "SKILL.md": "---\nname: not-whitelisted\n---\n" })

      const loaded = await loadCliSkills(dir)
      expect(loaded.version).toBe("9.9.9")
      expect(Object.keys(loaded.skills).sort()).toEqual([...CLI_BUNDLED_SKILLS].sort())
      expect(loaded.skills["not-whitelisted"]).toBeUndefined()
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })

  test("reads the real installed package when it ships skills", async () => {
    const root = resolveCliSkillsRoot(packageDir)
    if (!root) {
      // The pinned CLI release predates bundled skills; the build fails loudly in
      // that state, so there is nothing to assert here.
      return
    }
    if (CLI_BUNDLED_SKILLS.some((name) => !fs.existsSync(path.join(root, name)))) {
      // The installed release predates these whitelisted skills; skip until it ships them.
      return
    }
    const loaded = await loadCliSkills(packageDir)
    for (const name of CLI_BUNDLED_SKILLS) {
      expect(loaded.skills[name]?.["SKILL.md"]).toBeString()
    }
  })
})

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

describe("mergeSkills", () => {
  test("CLI skills win over repository copies of the same name", () => {
    const local: SkillsData = { a: { "SKILL.md": "local" }, b: { "SKILL.md": "local-b" } }
    const cli: SkillsData = { a: { "SKILL.md": "cli" }, c: { "SKILL.md": "cli-c" } }
    const merged = mergeSkills(local, cli)
    expect(merged.a["SKILL.md"]).toBe("cli")
    expect(merged.b["SKILL.md"]).toBe("local-b")
    expect(merged.c["SKILL.md"]).toBe("cli-c")
  })

  test("repository-owned deveco-cli is never replaced by the CLI copy", () => {
    // The two packages ship different documents under the same name: the CLI has
    // the plain command reference, this repo has the Router-aware adaptation.
    const local: SkillsData = { "deveco-cli": { "SKILL.md": "router-aware repo copy" } }
    const cli: SkillsData = { "deveco-cli": { "SKILL.md": "plain CLI copy" } }
    expect(mergeSkills(local, cli)["deveco-cli"]["SKILL.md"]).toBe("router-aware repo copy")
  })

  test("REPO_OWNED_SKILLS stays out of CLI_BUNDLED_SKILLS", () => {
    const bundled: readonly string[] = CLI_BUNDLED_SKILLS
    for (const name of REPO_OWNED_SKILLS) {
      expect(bundled).not.toContain(name)
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

  test("rejects a repository-owned skill in the CLI whitelist", () => {
    const data: SkillsData = { "deveco-cli": { "SKILL.md": "---\nname: deveco-cli\ndescription: x\n---\n" } }
    expect(validateSkills(data, ["deveco-cli"]).join("\n")).toContain("is repository-owned")
  })

  test("reports unsafe paths", () => {
    const data: SkillsData = {
      demo: { "SKILL.md": "---\nname: demo\ndescription: x\n---\n", "../escape.md": "x", "/abs.md": "x" },
    }
    const problems = validateSkills(data).join("\n")
    expect(problems).toContain('unsafe path "../escape.md"')
    expect(problems).toContain('unsafe path "/abs.md"')
  })
})

describe("loadResourceSkills", () => {
  test("reads the repository skills that remain local", async () => {
    const data = await loadResourceSkills(path.join(packageDir, "resources/skills"))
    expect(data["deveco-cli"]?.["SKILL.md"]).toBeString()
    expect(data["hmos-design-to-arkts"]?.["SKILL.md"]).toBeString()
    for (const name of CLI_BUNDLED_SKILLS) {
      expect(data[name]).toBeUndefined()
    }
  })

  test("returns an empty map when the directory is absent", async () => {
    expect(await loadResourceSkills(path.join(packageDir, "resources/does-not-exist"))).toEqual({})
  })
})