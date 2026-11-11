import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Entry } from "@opencode-ai/core/filesystem/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RelativePath } from "@opencode-ai/core/schema"
import { Cause, Effect, Exit, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import type { Permission } from "../../src/permission"
import type { Tool } from "@/tool/tool"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

let ripgrepCalls = 0

const node = CrossSpawnSpawner.defaultLayer
const ripgrep = Layer.mock(Ripgrep.Service, {
  find: (input) =>
    Effect.sync(() => {
      ripgrepCalls++
      expect(path.basename(input.cwd)).toBe("tool-skill")
      expect(input.pattern).toBe("!**/SKILL.md")
      expect(input.hidden).toBe(true)
      expect(input.follow).toBe(false)
      expect(input.signal).toBe(baseCtx.abort)
      expect(input.limit).toBe(10)
      return [
        new Entry({
          path: RelativePath.make("scripts/demo.txt"),
          type: "file",
          mime: "text/plain",
        }),
      ]
    }),
})

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node).pipe(Layer.provide(ripgrep)))

describe("tool.skill", () => {
  it.instance("execute returns skill content block with files", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const skill = path.join(dir, ".deveco", "skill", "tool-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skill, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "demo.txt"), "demo"))

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("gpt-5"),
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      expect(tool.description).not.toContain("tool-skill")
      expect(tool.description).not.toContain("Skill for tool tests.")

      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const ctx: Tool.Context = {
        ...baseCtx,
        ask: (req) =>
          Effect.sync(() => {
            requests.push(req)
          }),
      }

      const result = yield* tool.execute({ name: "tool-skill" }, ctx)
      const file = path.resolve(skill, "scripts", "demo.txt")

      expect(requests.length).toBe(1)
      expect(requests[0].permission).toBe("skill")
      expect(requests[0].patterns).toContain("tool-skill")
      expect(requests[0].always).toContain("tool-skill")
      expect(result.metadata.dir).toBe(skill)
      expect(result.output).toContain(`<skill_content name="tool-skill">`)
      expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(skill).href}`)
      expect(result.output).toContain(`<file>${file}</file>`)
    }),
    15_000,
  )

  it.instance("execute lists FILES.md whitelist paths instead of a sampled rg list", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const skill = path.join(dir, ".deveco", "skill", "whitelist-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skill, "SKILL.md"),
          `---
name: whitelist-skill
description: Skill with a companion whitelist.
---

# Whitelist Skill
`,
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(skill, "references", "analyzer.md"), "analyzer"))
      yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "run.py"), "print(1)"))
      // Not whitelisted: must not leak into the listing.
      yield* Effect.promise(() => Bun.write(path.join(skill, "test-cases", "junk.md"), "internal"))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skill, "FILES.md"),
          [
            "# whitelist",
            "@note note-from-whitelist",
            "references/analyzer.md",
            "scripts/run.py",
            "scripts/absent.py",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("gpt-5"),
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const before = ripgrepCalls
      const result = yield* tool.execute({ name: "whitelist-skill" }, { ...baseCtx, ask: () => Effect.void })

      // The whitelist branch must not fall back to sampling the directory.
      expect(ripgrepCalls).toBe(before)
      expect(result.output).toContain(`<file>${path.resolve(skill, "references", "analyzer.md")}</file>`)
      expect(result.output).toContain(`<file>${path.resolve(skill, "scripts", "run.py")}</file>`)
      expect(result.output).toContain(`<file>note-from-whitelist</file>`)
      expect(result.output).not.toContain("junk.md")
      // A whitelisted path that does not exist is dropped instead of being listed.
      expect(result.output).not.toContain("absent.py")
    }),
    15_000,
  )

  it.instance("execute preserves not found message", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("gpt-5"),
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const exit = yield* tool
        .execute(
          { name: "missing-skill" },
          {
            ...baseCtx,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) expect(error.message).toContain('Skill "missing-skill" not found.')
      }
    }),
    15_000,
  )
})
