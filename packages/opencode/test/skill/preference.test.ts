import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SkillPreference } from "../../src/skill/preference"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("skill preferences", () => {
  it("separates global state from per-project state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-skill-preferences-"))
    roots.push(root)

    await SkillPreference.setEnabled(root, "project-a", "global", "global-skill", false)
    await SkillPreference.setEnabled(root, "project-a", "project", "project-skill", false)

    const projectA = await SkillPreference.disabled(root, "project-a")
    const projectB = await SkillPreference.disabled(root, "project-b")

    expect(projectA.global.has("global-skill")).toBe(true)
    expect(projectB.global.has("global-skill")).toBe(true)
    expect(projectA.project.has("project-skill")).toBe(true)
    expect(projectB.project.has("project-skill")).toBe(false)
  })

  it("re-enables one project without changing another project", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-skill-preferences-"))
    roots.push(root)

    await SkillPreference.setEnabled(root, "project-a", "project", "shared-name", false)
    await SkillPreference.setEnabled(root, "project-b", "project", "shared-name", false)
    await SkillPreference.setEnabled(root, "project-a", "project", "shared-name", true)

    expect((await SkillPreference.disabled(root, "project-a")).project.has("shared-name")).toBe(false)
    expect((await SkillPreference.disabled(root, "project-b")).project.has("shared-name")).toBe(true)
  })

  it("reads the previous name-only format as global state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-skill-preferences-"))
    roots.push(root)
    await fs.writeFile(path.join(root, "skill-preferences.json"), JSON.stringify({ disabled: ["legacy-skill"] }))

    const state = await SkillPreference.disabled(root, "project-a")
    expect(state.global.has("legacy-skill")).toBe(true)
    expect(state.project.size).toBe(0)
  })
})
