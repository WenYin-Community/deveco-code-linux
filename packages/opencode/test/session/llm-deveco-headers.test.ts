import { describe, expect, test } from "bun:test"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { LLMRequestPrep } from "@/session/llm/request"

const deveco = LLMRequestPrep.devecoAffinityHeaders

describe("deveco proxy headers", () => {
  test("main agent request carries task, session, client and project headers", () => {
    const headers = deveco({ sessionID: "ses_main", messageID: "msg_abc" }, "prj_abc")
    expect(headers).toEqual({
      "x-deveco-project": "prj_abc",
      "x-deveco-session": "ses_main",
      "x-deveco-task": "msg_abc",
      "x-deveco-client": `deveco-code@${InstallationVersion}`,
      "User-Agent": `deveco/${InstallationVersion}`,
    })
  })

  test("no longer emits the legacy x-deveco-request header", () => {
    const headers = deveco({ sessionID: "ses_main", messageID: "msg_abc" }, undefined)
    expect(headers).not.toHaveProperty("x-deveco-request")
  })

  test("labels the client as deveco-code with the running version", () => {
    const headers = deveco({ sessionID: "ses_main", messageID: "msg_abc" }, undefined)
    expect(headers["x-deveco-client"]).toMatch(/^deveco-code@\S+$/)
    expect(headers["x-deveco-client"]).toBe(`deveco-code@${InstallationVersion}`)
    expect(["cli", "intellij", "desktop", "acp"]).not.toContain(headers["x-deveco-client"])
  })

  test("subagent request points x-deveco-parent-session at the spawning session", () => {
    const headers = deveco({ sessionID: "ses_child", parentSessionID: "ses_main", messageID: "msg_abc" }, undefined)
    expect(headers["x-deveco-session"]).toBe("ses_child")
    expect(headers["x-deveco-parent-session"]).toBe("ses_main")
  })

  test("main agent request omits the parent session header", () => {
    const headers = deveco({ sessionID: "ses_main", messageID: "msg_abc" }, undefined)
    expect(headers).not.toHaveProperty("x-deveco-parent-session")
  })

  test("omits the project header when the project is unknown", () => {
    const headers = deveco({ sessionID: "ses_main", messageID: "msg_abc" }, undefined)
    expect(headers).not.toHaveProperty("x-deveco-project")
  })
})
