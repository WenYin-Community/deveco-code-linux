import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import { AgentPromptProfile } from "./prompt/profile"
import PROMPT_DFX from "./prompt/dfx.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"

import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { Reference } from "@opencode-ai/core/reference"
import { Location } from "@opencode-ai/core/location"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = yield* Effect.gen(function* () {
          yield* (yield* PluginBoot.Service).wait()
          return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.config, "*"),
          path.join(Global.Path.tmp, "*"),
          path.join(Global.Path.data, "specs", "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          debug_exit: "deny",
          spec_write: "deny",
          repo_overview: "deny",
          verify_ui: "deny",
          save_ui_screenshot: "deny",
          get_ui_verification_log: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "ask",
                plan_write: "deny",
                verify_ui: "ask",
                save_ui_screenshot: "ask",
                get_ui_verification_log: "ask",
              }),
              user,
            ),
            mode: "primary",
            native: true,
            prompt: AgentPromptProfile.current.prompts.build,
          },
          debug: {
            name: "debug",
            description: "Sticky ArkTS debugging mode triggered by /debug",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                todowrite: "allow",
                debug_exit: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
            hidden: true,
            prompt: AgentPromptProfile.current.prompts.debug,
          },
          goal: {
            name: "goal",
            description: "Multi-turn goal-driven agent with verifiable termination",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
                webfetch: "allow",
                websearch: "allow",
                todowrite: "allow",
                spec_write: "allow",
                task: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
            prompt: AgentPromptProfile.current.prompts.goal,
            color: "info",
          },
          "spec-implementation": {
            name: "spec-implementation",
            description: "Execute implementation tasks from an approved spec",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
              }),
              user,
            ),
            mode: "subagent",
            native: true,
            hidden: true,
            prompt: AgentPromptProfile.current.prompts.specImplementation,
          },
          "spec-verify": {
            name: "spec-verify",
            description: "Build, deploy, and UI-verify Harmony features against spec",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                verify_ui: "allow",
                save_ui_screenshot: "allow",
                get_ui_verification_log: "allow",
              }),
              user,
            ),
            mode: "subagent",
            native: true,
            hidden: true,
            temperature: 0.2,
            prompt: AgentPromptProfile.current.prompts.specVerify,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                plan_write: "allow",
                task: {
                  general: "deny",
                },
                bash: "deny",
                switch_cwd: "deny",
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: "deny",
              }),
              user,
            ),
            mode: "primary",
            native: true,
            prompt: AgentPromptProfile.current.prompts.plan,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: AgentPromptProfile.current.prompts.explore,
            options: {},
            mode: "subagent",
            native: true,
          },
          dfx: {
            name: "dfx",
            description: `HarmonyOS DFX fault diagnosis and repair-planning specialist running in an isolated sub-session. Delegate to this agent when the user reports HarmonyOS application faults — freezes (AppFreeze / ANR / 冻屏 / 卡死 / 无响应), native C/C++ crashes (CppCrash), ArkTS/TypeScript runtime crashes (JSCrash / 闪退 / 崩溃 / 白屏退出), or non-crashing white screens (页面空白但进程未退出 / 空白页) — whether the user asks for analysis or repair, with FaultLog files, directories, pasted log content, or symptom descriptions alone and no log at all. If the hmos-dfx-analyzer skill is already loaded in your session, execute its analysis flow directly instead of delegating — the subagent would only load it a second time. Do not handle these faults yourself: its structured diagnosis (deterministic triage, root cause, target file:line) is the foundation that repair work should build on. This agent is also the executor of the explicit /analyze command. When delegating, pass the user's original request text verbatim plus any log file paths; do not paraphrase or trim fault descriptions. CRITICAL DELIVERY RULE: when the task result returns, you MUST immediately relay the DFX summary (the "## DFX 故障分析结论 block) verbatim to the user BEFORE doing any other work — the summary IS user-facing output, never absorb it as internal reference. Do not add, drop or reformat its lines, and never rewrite its absolute report path (under dfx-reports/ in the project directory) as a relative path. After relaying, for repair requests execute the repair following the summary's repair suggestions and minimal-fix execution constraints (the agent itself never edits source); for analysis requests, answer any follow-up questions. Do NOT delegate compile errors, general feature development, static-check issues, raw HiLog streams, or performance problems (memory leaks / OOM).`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                grep: "allow",
                glob: "allow",
                read: "allow",
                skill: {
                  // FR-16: only the DFX main skill is exposed to the dfx agent;
                  // everything else routes through its internal analyzers.
                  "*": "deny",
                  "hmos-dfx-analyzer": "allow",
                },
                arkts_knowledge_search: "allow",
                question: "allow", // 当期仅交互模式取 allow；非交互模式（后续支持时）此键需取 deny 而非 ask，否则 ask 在无应答者时会无限阻塞（V2 缺陷根源）
                webfetch: "allow",
                websearch: "allow",
                edit: "deny",
                bash: "allow",
                build_project: "deny",
                task: "deny",
                patch: "deny",
                switch_cwd: "deny",
                hdc_log: "deny",
                start_app: "deny",
                verify_ui: "deny",
                save_ui_screenshot: "deny",
                get_ui_verification_log: "deny",
                perform_ui_action: "deny",
                get_app_ui_tree: "deny",
                plan_enter: "deny",
                plan_exit: "deny",
                plan_write: "deny",
                spec_write: "deny",
                repo_clone: "deny",
                repo_overview: "deny",
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
            // SR1 v1.6: dfx always runs in a sub-session — via the /analyze
            // command (subtask: true) or natural-language Task delegation from
            // the main agent. Hidden from agent pickers and @-mention
            // autocomplete; delegation is model-initiated via the task tool.
            hidden: true,
            prompt: PROMPT_DFX,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: AgentPromptProfile.current.prompts.compaction,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: AgentPromptProfile.current.prompts.title,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: AgentPromptProfile.current.prompts.summary,
          },
        }

        const enabled = new Set<string>(AgentPromptProfile.current.agents)
        for (const name of Object.keys(agents)) {
          if (!enabled.has(name)) delete agents[name]
        }

        for (const [name, override] of Object.entries(AgentPromptProfile.current.overrides)) {
          const item = agents[name]
          if (!item) continue
          item.description = override.description ?? item.description
          item.mode = override.mode ?? item.mode
          item.hidden = override.hidden ?? item.hidden
          item.color = override.color ?? item.color
          item.temperature = override.temperature ?? item.temperature
          item.topP = override.topP ?? item.topP
          item.steps = override.steps ?? item.steps
          item.permission = Permission.merge(item.permission, Permission.fromConfig(override.permission ?? {}))
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [
                (x) =>
                  cfg.default_agent ? x.name === cfg.default_agent : x.name === AgentPromptProfile.current.defaultAgent,
                "desc",
              ],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const preferred = agents[AgentPromptProfile.current.defaultAgent]
          if (preferred && preferred.mode !== "subagent" && preferred.hidden !== true) return preferred
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [AgentPromptProfile.current.prompts.generate]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
          experimental_repairText: async ({ text }: { text: string }) => {
            // Some models wrap JSON in markdown code blocks (```json ... ```)
            return text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "")
          },
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
)

const locationServiceMapNode = LayerNode.make(LocationServiceMap.layer, [])

export const node = LayerNode.make(layer, [
  Config.node,
  Auth.node,
  Plugin.node,
  Skill.node,
  Provider.node,
  locationServiceMapNode,
])

export * as Agent from "./agent"
