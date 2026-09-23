import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentPromptProfile } from "@/agent/prompt/profile"
import { SessionPromptProfile } from "@/session/prompt/profile"

describe("runtime prompt profiles", () => {
  test("keeps a separately selectable Studio agent flow", () => {
    const defaults = AgentPromptProfile.select("default")
    const studio = AgentPromptProfile.select("deveco-studio")

    expect(studio).not.toBe(defaults)
    expect(studio.defaultAgent).toBe(defaults.defaultAgent)
    expect(studio.agents).toEqual(defaults.agents)
    expect(studio.agents).not.toBe(defaults.agents)
    expect(studio.overrides).not.toBe(defaults.overrides)
    expect(studio.prompts).toEqual(defaults.prompts)
  })

  test("keeps a separately selectable Studio system prompt set", () => {
    const defaults = SessionPromptProfile.select("default")
    const studio = SessionPromptProfile.select("deveco-studio")

    expect(studio).not.toBe(defaults)
    expect(studio).toEqual(defaults)
  })

  test("selects both Studio profiles from the process runtime contract", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-studio-profile-"))
    const agentUrl = new URL("../../src/agent/prompt/profile.ts", import.meta.url).href
    const sessionUrl = new URL("../../src/session/prompt/profile.ts", import.meta.url).href
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        [
          `const { AgentPromptProfile } = await import(${JSON.stringify(agentUrl)})`,
          `const { SessionPromptProfile } = await import(${JSON.stringify(sessionUrl)})`,
          'console.log(JSON.stringify({ agent: AgentPromptProfile.current === AgentPromptProfile.profiles["deveco-studio"], session: SessionPromptProfile.current === SessionPromptProfile.profiles["deveco-studio"] }))',
        ].join(";"),
      ],
      {
        env: {
          ...process.env,
          DEVECO_RUNTIME_MODE: "deveco-studio",
          DEVECO_STORAGE_ROOT: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = JSON.parse(await new Response(child.stdout).text())
    expect(await child.exited).toBe(0)
    expect(output).toEqual({ agent: true, session: true })
    await fs.rm(root, { recursive: true, force: true })
  })
})
