import { expect, describe, it, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  BUILTIN_COMMANDS,
  RETIRED_COMMANDS,
  renderCommandFile,
  createCommandFiles,
  cleanupRetiredCommandFiles,
  getGlobalConfigPaths,
} from "../../../src/plugin/memory/slashCommands/commandFiles"
import { Global } from "@opencode-ai/core/global"

describe("memory plugin command files", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deveco-cmdfiles-"))
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  it("creates only the two visible builtin commands", () => {
    createCommandFiles(dir)
    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual(["auto-skill.md", "dream-force.md"])
  })

  it("does not overwrite an existing command file", () => {
    const target = path.join(dir, "dream-force.md")
    fs.writeFileSync(target, "custom", "utf-8")
    createCommandFiles(dir)
    expect(fs.readFileSync(target, "utf-8")).toBe("custom")
  })

  it("deletes retired command files that match the legacy template exactly", () => {
    for (const cmd of RETIRED_COMMANDS) {
      fs.writeFileSync(path.join(dir, `${cmd.name}.md`), renderCommandFile(cmd), "utf-8")
    }
    cleanupRetiredCommandFiles(dir)
    for (const cmd of RETIRED_COMMANDS) {
      expect(fs.existsSync(path.join(dir, `${cmd.name}.md`))).toBe(false)
    }
  })

  it("keeps user-modified retired command files", () => {
    fs.writeFileSync(path.join(dir, "dream-approve.md"), "---\ndescription: my own\n---\n\ncustom\n", "utf-8")
    cleanupRetiredCommandFiles(dir)
    expect(fs.existsSync(path.join(dir, "dream-approve.md"))).toBe(true)
  })

  it("has no overlap between builtin and retired sets", () => {
    const builtinNames = BUILTIN_COMMANDS.map((c) => c.name)
    const retiredNames = RETIRED_COMMANDS.map((c) => c.name)
    expect(builtinNames.filter((n) => retiredNames.includes(n))).toEqual([])
  })

  it("targets the app's global config commands dir", () => {
    // The app globs {command,commands}/**/*.md under Global.Path.config
    // (ConfigPaths.directories); the plugin must write the same location.
    expect(getGlobalConfigPaths()).toEqual([path.join(Global.Path.config, "commands")])
  })
})
