import { afterEach, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { Truncate } from "../../src/tool/truncate"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const it = testEffect(agentLayer())

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionV1.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

const expectDefaultAgentError = Effect.fn("AgentTest.expectDefaultAgentError")(function* (message: string) {
  const exit = yield* load((svc) => svc.defaultAgent()).pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
})

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("returns default native agents when no config", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    const names = agents.map((a) => a.name)
    expect(names).toContain("build")
    expect(names).toContain("plan")
    expect(names).toContain("general")
    expect(names).toContain("explore")
    expect(names).toContain("compaction")
    expect(names).toContain("title")
    expect(names).toContain("summary")
  }),
)

it.instance("build agent has correct default properties", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(build).toBeDefined()
    expect(build?.mode).toBe("primary")
    expect(build?.native).toBe(true)
    expect(evalPerm(build, "edit")).toBe("allow")
    expect(evalPerm(build, "bash")).toBe("allow")
  }),
)

it.instance("build asks and spec-verify allows UI verification tools by default", () =>
  Effect.gen(function* () {
    const uiTools = ["verify_ui", "save_ui_screenshot", "get_ui_verification_log"] as const
    const agents = yield* load((svc) =>
      Effect.all([
        svc.get("build"),
        svc.get("spec-verify"),
        svc.get("spec-implementation"),
        svc.get("goal"),
        svc.get("plan"),
        svc.get("general"),
        svc.get("explore"),
        svc.get("compaction"),
        svc.get("title"),
        svc.get("summary"),
      ]),
    )

    const [build, specVerify, specImplementation, goal, plan, general, explore, compaction, title, summary] = agents

    for (const tool of uiTools) {
      expect(evalPerm(build, tool)).toBe("ask")
      expect(evalPerm(specVerify, tool)).toBe("allow")
    }

    for (const agent of [specImplementation, goal, plan, general, explore, compaction, title, summary]) {
      for (const tool of uiTools) {
        expect(evalPerm(agent, tool)).toBe("deny")
      }
    }
  }),
)

it.instance("spec-implementation agent is a native subagent with correct permissions", () =>
  Effect.gen(function* () {
    const impl = yield* load((svc) => svc.get("spec-implementation"))
    expect(impl).toBeDefined()
    expect(impl?.mode).toBe("subagent")
    expect(impl?.native).toBe(true)
    expect(impl?.hidden).toBe(true)
    expect(evalPerm(impl, "edit")).toBe("allow")
    expect(evalPerm(impl, "write")).toBe("allow")
    expect(evalPerm(impl, "read")).toBe("allow")
    expect(evalPerm(impl, "bash")).toBe("allow")
    expect(evalPerm(impl, "question")).toBe("allow")
    expect(evalPerm(impl, "verify_ui")).toBe("deny")
  }),
)

// The plan agent's edit permission is "deny" for wildcards, and the
// external_directory allow is scoped to Global.Path.data/plans/* which on Windows
// resolves to an absolute path under LOCALAPPDATA/deveco/plans/*. A relative
// path like ".deveco/plans/foo.md" won't match; evaluate against the absolute
// resolved path instead.
it.instance("plan agent denies edits except data/plans/*", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    // Wildcard is denied
    expect(evalPerm(plan, "edit")).toBe("deny")
    // The allowed path uses Global.Path.data which on Windows is an absolute
    // path like C:\Users\...\AppData\Local\deveco\plans. Check the allow rule
    // exists in the permission list (exact path varies by platform).
    const plansAllow = plan!.permission.some(
      (r) => r.permission === "external_directory" && r.action === "allow" && typeof r.pattern === "string" && r.pattern.includes("plans"),
    )
    expect(plansAllow).toBe(true)
  }),
)

it.instance("plan agent denies the general subagent by default", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "explore", plan!.permission).action).toBe("allow")
    expect(Permission.evaluate("task", "custom", plan!.permission).action).toBe("allow")
  }),
)

it.instance(
  "user permission can allow the general subagent from plan mode",
  () =>
    Effect.gen(function* () {
      const plan = yield* load((svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("allow")
    }),
  {
    config: {
      permission: {
        task: {
          general: "allow",
        },
      },
    },
  },
)

it.instance("explore agent denies edit and write", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(explore?.mode).toBe("subagent")
    expect(evalPerm(explore, "edit")).toBe("deny")
    expect(evalPerm(explore, "write")).toBe("deny")
    expect(evalPerm(explore, "todowrite")).toBe("deny")
  }),
)

it.instance("explore agent asks for external directories and allows whitelisted external paths", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(Permission.evaluate("external_directory", "/some/other/path", explore!.permission).action).toBe("ask")
    expect(Permission.evaluate("external_directory", Truncate.GLOB, explore!.permission).action).toBe("allow")
    expect(
      Permission.evaluate("external_directory", path.join(Global.Path.tmp, "agent-work"), explore!.permission).action,
    ).toBe("allow")
  }),
)

it.instance("dfx agent allows analysis scripts but denies code modification", () =>
  Effect.gen(function* () {
    const dfx = yield* load((svc) => svc.get("dfx"))
    expect(dfx).toBeDefined()
    expect(dfx?.mode).toBe("subagent")
    expect(dfx?.native).toBe(true)
    // SR1 v1.6: hidden from pickers and @-mention autocomplete; natural
    // language analysis is delegated by the main agent via the task tool,
    // which surfaces the description regardless of hidden.
    expect(dfx?.hidden).toBe(true)
    expect(dfx?.description).toContain("running in an isolated sub-session")
    expect(dfx?.description).toContain("Delegate to this agent")
    expect(dfx?.description).toContain("executor of the explicit /analyze command")
    expect(dfx?.description).toContain("dfx-reports/")
    expect(dfx?.description).toContain("pass the user's original request text verbatim")
    // SR1 v1.8 fusion: symptom-only delegation (device-side collection) and the
    // repair-task routing claim (report-driven, main-agent execution; the
    // description explicitly claims repair-intent requests and forbids
    // self-handling so the main agent stops shortcutting to direct fixes).
    expect(dfx?.description).toContain("diagnosis and repair-planning specialist")
    expect(dfx?.description).toContain("whether the user asks for analysis or repair")
    expect(dfx?.description).toContain("Do not handle these faults yourself")
    // 加载即直执：skill 已加载则本会话直执，不再委派（双重加载防护，
    // 实测回归：ses_ebc2bc406 加载 skill 后仍委派 dfx，子代理重复加载）
    expect(dfx?.description).toContain("If the hmos-dfx-analyzer skill is already loaded in your session")
    expect(dfx?.description).toContain("execute its analysis flow directly instead of delegating")
    expect(dfx?.description).toContain("the subagent would only load it a second time")
    expect(dfx?.description).toContain("the agent itself never edits source")
    expect(dfx?.description).toContain("symptom descriptions alone and no log at all")
    expect(dfx?.description).toContain("symptom descriptions alone and no log at all")
    expect(dfx?.description).toContain("minimal-fix execution constraints")
    expect(dfx?.description).toContain("ArkTS/TypeScript")
    expect(dfx?.description).toContain("CRITICAL DELIVERY RULE")
    expect(dfx?.description).toContain("MUST immediately relay the DFX summary")
    expect(dfx?.description).toContain("the summary IS user-facing output")
    expect(dfx?.description).toContain("never rewrite its absolute report path")
    expect(dfx?.description).toContain("as a relative path")
    expect(dfx?.description).toContain("Do NOT delegate compile errors")
    expect(dfx?.description).toContain("raw HiLog streams")
    expect(dfx?.description).not.toContain("started exclusively via the /analyze command")
    expect(dfx?.description).not.toContain("load the hmos-dfx-analyzer skill instead")

    for (const permission of [
      "grep",
      "glob",
      "read",
      "arkts_knowledge_search",
      "question",
      "webfetch",
      "websearch",
      "bash",
    ]) {
      expect(evalPerm(dfx, permission)).toBe("allow")
    }

    for (const permission of [
      "edit",
      "build_project",
      "task",
      "patch",
      "switch_cwd",
      "hdc_log",
      "start_app",
      "verify_ui",
      "save_ui_screenshot",
      "get_ui_verification_log",
      "perform_ui_action",
      "get_app_ui_tree",
      "plan_enter",
      "plan_exit",
      "plan_write",
      "spec_write",
      "repo_clone",
      "repo_overview",
      "todowrite",
    ]) {
      expect(evalPerm(dfx, permission)).toBe("deny")
    }

    expect(evalPerm(dfx, "doom_loop")).toBe("ask")
    // SR1 v1.8 variant 1b: the DFX main skill is loadable by every agent. In
    // DevEco Code the main agent loads it through the skill channel and its
    // routing preamble redirects to the dfx subagent; third-party hosts
    // execute the skill directly (marketplace pure-skill form, FR-30).
    expect(Permission.evaluate("skill", "hmos-dfx-analyzer", dfx!.permission).action).toBe("allow")
    expect(Permission.evaluate("skill", "arkts-error-fixes", dfx!.permission).action).toBe("deny")
    const build = yield* load((svc) => svc.get("build"))
    expect(Permission.evaluate("skill", "hmos-dfx-analyzer", build!.permission).action).toBe("allow")
    expect(Permission.disabled(["edit", "write", "apply_patch"], dfx!.permission)).toEqual(
      new Set(["edit", "write", "apply_patch"]),
    )
    expect(Permission.evaluate("external_directory", "/some/other/path", dfx!.permission).action).toBe("ask")
    // Thin system prompt: identity, entry constraint, agent-level boundary and
    // session facts only. Triage/routing/delivery flow must live in the skill.
    expect(dfx?.prompt).toContain("hmos-dfx-analyzer")
    expect(dfx?.prompt).toContain("真值源")
    expect(dfx?.prompt).toContain("本提示词不重复其内容")
    expect(dfx?.prompt).toContain("AppFreeze")
    expect(dfx?.prompt).toContain("CppCrash")
    expect(dfx?.prompt).toContain("JSCrash")
    expect(dfx?.prompt).toContain("不主动修改用户业务源码")
    expect(dfx?.prompt).toContain("不等同于")
    expect(dfx?.prompt).toContain("为由拒绝执行")
    expect(dfx?.prompt).toContain("<DFX_USER_ARGUMENTS>")
    // SR1 v1.6: delegation re-opened — both entries run in an isolated
    // sub-session, and the prompt pins the concise-summary + HTML-report
    // delivery form.
    expect(dfx?.prompt).toContain("你始终运行在隔离子会话中")
    expect(dfx?.prompt).toContain("主 Agent 的自然语言委派")
    // SR1 v1.8 fusion: symptom-only requests collect device-side evidence inside
    // the sub-session, then must go through deterministic triage.
    expect(dfx?.prompt).toContain("症状入口与采集流程")
    expect(dfx?.prompt).toContain("不得按症状预设故障类型")
    expect(dfx?.prompt).toContain("会话内只回 markdown 格式简洁摘要")
    expect(dfx?.prompt).toContain("含下划线的标识符一律用行内代码包裹")
    expect(dfx?.prompt).toContain("export_report.py")
    expect(dfx?.prompt).toContain("dfx-reports/")
    expect(dfx?.prompt).toContain('"分析报告"字段必须是脚本回显的绝对路径')
    expect(dfx?.prompt).not.toContain("主 Agent 会自行加载 DFX 主 Skill")
    // FR-27: fix-intent tail status is pinned; no freestyle read-only disclaimers.
    expect(dfx?.prompt).not.toContain("报告交付格式")
    expect(dfx?.prompt).not.toContain("结果处置决策表")
    expect(dfx?.prompt).not.toContain("领域词汇归一表")
    expect(dfx?.prompt).not.toContain("候选回退上限为一次")
    expect(dfx?.prompt).not.toContain("呈现与交付")
  }),
)

it.instance(
  "reference config does not create subagents",
  () =>
    Effect.gen(function* () {
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((agent) => agent.name)
      expect(names).not.toContain("effect")
      expect(names).not.toContain("effectFull")
      expect(names).not.toContain("localdocs")
      expect(names).not.toContain("localdocsFull")
    }),
  {
    config: {
      references: {
        effect: "github.com/effect/effect-smol",
        effectFull: {
          repository: "Effect-TS/effect",
          branch: "main",
        },
        localdocs: "../docs",
        localdocsFull: {
          path: "../local-docs",
        },
      },
    },
  },
)

it.instance("general agent denies todo tools", () =>
  Effect.gen(function* () {
    const general = yield* load((svc) => svc.get("general"))
    expect(general).toBeDefined()
    expect(general?.mode).toBe("subagent")
    expect(general?.hidden).toBeUndefined()
    expect(evalPerm(general, "todowrite")).toBe("deny")
  }),
)

it.instance("compaction agent denies all permissions", () =>
  Effect.gen(function* () {
    const compaction = yield* load((svc) => svc.get("compaction"))
    expect(compaction).toBeDefined()
    expect(compaction?.hidden).toBe(true)
    expect(evalPerm(compaction, "bash")).toBe("deny")
    expect(evalPerm(compaction, "edit")).toBe("deny")
    expect(evalPerm(compaction, "read")).toBe("deny")
  }),
)

it.instance(
  "custom agent from config creates new agent",
  () =>
    Effect.gen(function* () {
      const custom = yield* load((svc) => svc.get("my_custom_agent"))
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    }),
  {
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  },
)

it.instance(
  "custom agent config overrides native agent properties",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(String(build?.model?.providerID)).toBe("anthropic")
      expect(String(build?.model?.modelID)).toBe("claude-3")
      expect(build?.description).toBe("Custom build agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    }),
  {
    config: {
      agent: {
        build: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  },
)

it.instance(
  "agent disable removes agent from list",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore).toBeUndefined()
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    }),
  {
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  },
)

it.instance(
  "agent permission config merges with defaults",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      // Specific pattern is denied
      expect(Permission.evaluate("bash", "rm -rf *", build!.permission).action).toBe("deny")
      // Edit still allowed
      expect(evalPerm(build, "edit")).toBe("allow")
    }),
  {
    config: {
      agent: {
        build: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  },
)

it.instance(
  "global permission config applies to all agents",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(evalPerm(build, "bash")).toBe("deny")
    }),
  {
    config: {
      permission: {
        bash: "deny",
      },
    },
  },
)

it.instance(
  "agent steps/maxSteps config sets steps property",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      const plan = yield* load((svc) => svc.get("plan"))
      expect(build?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    }),
  {
    config: {
      agent: {
        build: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  },
)

it.instance(
  "agent mode can be overridden",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore?.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  },
)

it.instance(
  "agent name can be overridden",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.name).toBe("Builder")
    }),
  {
    config: {
      agent: {
        build: { name: "Builder" },
      },
    },
  },
)

it.instance(
  "agent prompt can be set from config",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.prompt).toBe("Custom system prompt")
    }),
  {
    config: {
      agent: {
        build: { prompt: "Custom system prompt" },
      },
    },
  },
)

it.instance(
  "unknown agent properties are placed into options",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    }),
  {
    config: {
      agent: {
        build: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  },
)

it.instance(
  "agent options merge correctly",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    }),
  {
    config: {
      agent: {
        build: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  },
)

it.instance(
  "multiple custom agents can be defined",
  () =>
    Effect.gen(function* () {
      const agentA = yield* load((svc) => svc.get("agent_a"))
      const agentB = yield* load((svc) => svc.get("agent_b"))
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  },
)

it.instance(
  "Agent.list keeps the default agent first and sorts the rest by name",
  () =>
    Effect.gen(function* () {
      const names = (yield* load((svc) => svc.list())).map((a) => a.name)
      expect(names[0]).toBe("plan")
      expect(names.slice(1)).toEqual(names.slice(1).toSorted((a, b) => a.localeCompare(b)))
    }),
  {
    config: {
      default_agent: "plan",
      agent: {
        zebra: {
          description: "Zebra",
          mode: "subagent",
        },
        alpha: {
          description: "Alpha",
          mode: "subagent",
        },
      },
    },
  },
)

it.instance("Agent.get returns undefined for non-existent agent", () =>
  Effect.gen(function* () {
    const nonExistent = yield* load((svc) => svc.get("does_not_exist"))
    expect(nonExistent).toBeUndefined()
  }),
)

it.instance("default permission includes doom_loop and external_directory as ask", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(evalPerm(build, "doom_loop")).toBe("ask")
    expect(evalPerm(build, "external_directory")).toBe("ask")
  }),
)

it.instance("webfetch is allowed by default", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(evalPerm(build, "webfetch")).toBe("allow")
  }),
)

it.instance(
  "legacy tools config converts to permissions",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  },
)

it.instance(
  "legacy tools config maps write/edit/patch to edit permission",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "edit")).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          tools: {
            write: false,
          },
        },
      },
    },
  },
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory globally",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  },
)

it.instance("global tmp directory children are allowed for external_directory", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(
      Permission.evaluate("external_directory", path.join(Global.Path.tmp, "scratch"), build!.permission).action,
    ).toBe("allow")
    expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("ask")
  }),
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory per-agent",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    }),
  {
    config: {
      agent: {
        build: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  },
)

it.instance(
  "explicit Truncate.GLOB deny is respected",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.GLOB]: "deny",
        },
      },
    },
  },
)

it.instance(
  "skill directories are allowed for external_directory",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const skillDir = path.join(test.directory, ".deveco", "skill", "perm-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
        ),
      )

      const home = process.env.DEVECO_TEST_HOME
      process.env.DEVECO_TEST_HOME = test.directory
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.DEVECO_TEST_HOME = home
        }),
      )

      const build = yield* load((svc) => svc.get("build"))
      const target = path.join(skillDir, "reference", "notes.md")
      expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("allow")
    }),
  { git: true },
)

it.instance(
  "project reference directories are allowed for external_directory",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const build = yield* load((svc) => svc.get("build"))
      const target = path.resolve(test.directory, "../docs/reference/notes.md")
      expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("allow")
    }),
  {
    git: true,
    config: {
      references: {
        docs: "../docs",
      },
    },
  },
)

it.instance("defaultAgent returns build when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultAgent())
    expect(agent).toBe("build")
  }),
)

it.instance("defaultInfo returns resolved build agent when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultInfo())
    expect(agent.name).toBe("build")
    expect(agent.mode).toBe("primary")
  }),
)

it.instance(
  "defaultAgent respects default_agent config set to plan",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("plan")
    }),
  {
    config: {
      default_agent: "plan",
    },
  },
)

it.instance(
  "defaultAgent respects default_agent config set to custom agent with mode all",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("my_custom")
    }),
  {
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to subagent",
  () => expectDefaultAgentError('default agent "explore" is a subagent'),
  {
    config: {
      default_agent: "explore",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to hidden agent",
  () => expectDefaultAgentError('default agent "compaction" is hidden'),
  {
    config: {
      default_agent: "compaction",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to non-existent agent",
  () => expectDefaultAgentError('default agent "does_not_exist" not found'),
  {
    config: {
      default_agent: "does_not_exist",
    },
  },
)

it.instance(
  "defaultAgent returns goal when build is disabled and default_agent not set",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      // build is disabled, so it returns the first primary non-hidden agent
      // by insertion order: build, debug, goal, spec-impl, spec-verify, plan,
      // general, explore, compaction, summary. goal is the first primary
      // non-hidden after build.
      expect(agent).toBe("goal")
    }),
  {
    config: {
      agent: {
        build: { disable: true },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when all primary agents are disabled",
  () => expectDefaultAgentError("no primary visible agent found"),
  {
    config: {
      agent: {
        build: { disable: true },
        goal: { disable: true },
        plan: { disable: true },
        ask: { disable: true },
        compaction: { disable: true },
        summary: { disable: true },
      },
    },
  },
)
