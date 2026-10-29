/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { providerRevision } from "../../../../src/context/sync"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("provider refresh only reloads provider state", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const calls: string[] = []
    let refreshing = false
    const { app, sync } = await mount((url): Response | undefined => {
      if (!refreshing) return undefined
      calls.push(url.pathname)
      if (url.pathname === "/provider/refresh") {
        return json({
          all: [{ id: "openai", name: "OpenAI", source: "api", env: [], options: {}, models: {} }],
          default: { openai: "gpt-test" },
          connected: ["openai"],
        })
      }
      if (url.pathname === "/config/providers") {
        return json({
          providers: [{ id: "openai", name: "OpenAI", source: "api", env: [], options: {}, models: {} }],
          default: { openai: "gpt-test" },
        })
      }
      if (url.pathname === "/provider/auth") return json({ openai: [{ type: "api", label: "API key" }] })
      return undefined
    }, tmp.path)

    try {
      refreshing = true
      expect(providerRevision(sync.data)).toBe(1)
      await sync.provider.refresh()

      expect(calls[0]).toBe("/provider/refresh")
      expect(calls.slice(1).sort()).toEqual(["/config/providers", "/provider/auth"])
      expect(sync.data.provider_next.connected).toEqual(["openai"])
      expect(sync.data.provider[0]?.id).toBe("openai")
      expect(sync.data.provider_auth.openai?.[0]?.type).toBe("api")
      expect(providerRevision(sync.data)).toBe(2)

      const providers = sync.data.provider
      await sync.provider.refresh()
      expect(sync.data.provider).toBe(providers)
      expect(providerRevision(sync.data)).toBe(3)
    } finally {
      app.renderer.destroy()
    }
  })
})
