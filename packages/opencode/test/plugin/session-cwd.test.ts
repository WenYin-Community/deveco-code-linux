import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { SessionCwdPlugin } from "../../src/plugin/session-cwd"
import { clearSessionCwd, getSessionCwd, setSessionCwd } from "../../src/tool/lib/session-cwd"

afterEach(() => clearSessionCwd())

describe("plugin session directory host adapter", () => {
  test("consumes the validated directory of a successful create", async () => {
    await using tmp = await tmpdir()
    const hooks = await SessionCwdPlugin()
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "session-a", callID: "create", source: "builtin", args: {} },
      {
        title: "Create",
        output: "",
        metadata: { sessionCwd: tmp.path },
      },
    )
    expect(getSessionCwd("session-a")).toBe(tmp.path)
    expect(getSessionCwd("session-b")).toBeUndefined()
  })

  test.each([undefined, "relative/project"])(
    "ignores CLI events without an absolute sessionCwd: %s",
    async (sessionCwd) => {
      await using tmp = await tmpdir()
      const hooks = await SessionCwdPlugin()
      const previous = path.resolve("previous")
      setSessionCwd("session-a", previous)
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: "session-a", callID: "create", source: "builtin", args: {} },
        {
          title: "",
          output: "",
          metadata: {
            sessionCwd,
            devecoCliEvents: [{ command: "create", exitCode: 0, durationMs: 1, projectRoot: tmp.path }],
          },
        },
      )
      expect(getSessionCwd("session-a")).toBe(previous)
    },
  )

  test("uses the resolved result directory instead of the requested path", async () => {
    const hooks = await SessionCwdPlugin()
    const target = path.resolve("resolved project with spaces")
    setSessionCwd("session-a", path.resolve("previous project"))

    await hooks["tool.execute.after"]!(
      {
        tool: "switch_cwd",
        sessionID: "session-a",
        callID: "switch",
        source: "custom",
        args: { project_path: "requested" },
      },
      { title: "Switch project context", output: "", metadata: { project_path: target } },
    )

    expect(getSessionCwd("session-a")).toBe(target)
    expect(getSessionCwd("session-b")).toBeUndefined()
  })

  test("keeps directory switches isolated between sessions", async () => {
    const hooks = await SessionCwdPlugin()
    const first = path.resolve("first project")
    const second = path.resolve("second project")
    for (const [sessionID, target] of [
      ["session-a", first],
      ["session-b", second],
    ]) {
      await hooks["tool.execute.after"]!(
        { tool: "switch_cwd", sessionID, callID: "switch", source: "custom", args: {} },
        { title: "", output: "", metadata: { project_path: target } },
      )
    }

    expect(getSessionCwd("session-a")).toBe(first)
    expect(getSessionCwd("session-b")).toBe(second)
  })

  test.each([undefined, null, {}, { project_path: "relative/project" }, { project_path: "" }, { project_path: 123 }])(
    "ignores missing or invalid result metadata: %j",
    async (metadata) => {
      const hooks = await SessionCwdPlugin()
      const previous = path.resolve("previous project")
      setSessionCwd("session-a", previous)
      await hooks["tool.execute.after"]!(
        {
          tool: "switch_cwd",
          sessionID: "session-a",
          callID: "switch",
          source: "custom",
          args: { project_path: path.resolve("requested") },
        },
        { title: "", output: "", metadata },
      )
      expect(getSessionCwd("session-a")).toBe(previous)
    },
  )

  test.each([
    { tool: "bash", source: "custom" as const },
    { tool: "switch_cwd", source: "builtin" as const },
    { tool: "switch_cwd", source: "mcp" as const },
  ])("ignores unrelated tools and sources: %j", async ({ tool, source }) => {
    const hooks = await SessionCwdPlugin()
    await hooks["tool.execute.after"]!(
      { tool, sessionID: "session-a", callID: "call", source, args: {} },
      { title: "", output: "", metadata: { project_path: path.resolve("project") } },
    )
    expect(getSessionCwd("session-a")).toBeUndefined()
  })

  test("clears only the deleted session's directory", async () => {
    const hooks = await SessionCwdPlugin()
    const target = path.resolve("project")
    setSessionCwd("session-a", target)
    setSessionCwd("session-b", target)

    await hooks.event!({
      event: {
        type: "session.deleted",
        properties: {
          info: {
            id: "session-a",
            projectID: "project",
            directory: target,
            title: "Session",
            version: "1",
            time: { created: 0, updated: 0 },
          },
        },
      },
    })

    expect(getSessionCwd("session-a")).toBeUndefined()
    expect(getSessionCwd("session-b")).toBe(target)
  })
})
