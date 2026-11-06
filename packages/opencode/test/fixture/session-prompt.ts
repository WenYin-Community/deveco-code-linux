import { NodeFileSystem } from "@effect/platform-node"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { AppProcess } from "@opencode-ai/core/process"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FetchHttpClient } from "effect/unstable/http"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { Deferred, Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionSnip } from "../../src/session/snip"
import { LLM } from "../../src/session/llm"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { ExitQueue } from "../../src/session/exit-queue"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Storage } from "@/storage/storage"
import { SessionAgentMode } from "../../src/session/agent-mode/routing"
import { Skill } from "../../src/skill"
import { Discovery } from "../../src/skill/discovery"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Entry } from "@opencode-ai/core/filesystem/schema"
import { RelativePath } from "@opencode-ai/core/schema"
import { Format } from "../../src/format"
import { TestInstance } from "./fixture"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const auth = Layer.mock(Auth.Service, {
  get: () => Effect.succeed(undefined),
  all: () => Effect.succeed({}),
})

const ripgrep = Layer.mock(Ripgrep.Service, {
  glob: () =>
    Effect.succeed([
      new Entry({
        path: RelativePath.make("probe.txt"),
        type: "file",
        mime: "text/plain",
      }),
    ]),
})

const runtime = RuntimeFlags.layer({
  pure: true,
  disableDefaultPlugins: true,
  disableDefaultSkills: true,
  experimentalEventSystem: true,
})

const config = Config.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(auth),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(FetchHttpClient.layer),
)

const plugin = Plugin.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(config),
  Layer.provide(runtime),
)

const skill = Skill.layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(config),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(runtime),
)

const provider = Provider.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(config),
  Layer.provide(auth),
  Layer.provide(plugin),
  Layer.provide(ModelsDev.defaultLayer),
  Layer.provide(runtime),
)

const agent = Agent.layer.pipe(
  Layer.provide(config),
  Layer.provide(auth),
  Layer.provide(plugin),
  Layer.provide(skill),
  Layer.provide(provider),
  Layer.provide(LocationServiceMap.layer),
)

const snapshot = Snapshot.layer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(config),
)

const llm = LLM.layer.pipe(
  Layer.provide(auth),
  Layer.provide(config),
  Layer.provide(provider),
  Layer.provide(plugin),
  Layer.provide(
    LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
  ),
  Layer.provide(runtime),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const command = Command.layer.pipe(
  Layer.provide(config),
  Layer.provide(mcp),
  Layer.provide(skill),
  Layer.provide(runtime),
)

const instruction = Instruction.layer.pipe(
  Layer.provide(config),
  Layer.provide(Global.layer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(runtime),
)

const systemPrompt = SystemPrompt.layer.pipe(Layer.provide(skill), Layer.provide(LocationServiceMap.layer))

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))

const agentMode = SessionAgentMode.defaultLayer

const run = SessionRunState.layer.pipe(Layer.provide(status))

const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const session = Session.defaultLayer

const sessionRevert = SessionRevert.layer.pipe(
  Layer.provide(run),
  Layer.provide(session),
  Layer.provide(snapshot),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(summary),
)

export const processorCreateStarted: Array<() => void> = []

const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const deps = Layer.mergeAll(
  session,
  snapshot,
  llm,
  Env.defaultLayer,
  agent,
  command,
  Permission.defaultLayer,
  plugin,
  config,
  provider,
  lsp,
  mcp,
  FSUtil.defaultLayer,
  BackgroundJob.defaultLayer,
  status,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
  Global.defaultLayer,
).pipe(Layer.provideMerge(infra))
const question = Question.layer.pipe(Layer.provideMerge(deps))
const todo = Todo.layer.pipe(Layer.provideMerge(deps))
const registry = ToolRegistry.layer.pipe(
  Layer.provide(auth),
  Layer.provide(skill),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(ripgrep),
  Layer.provide(Format.defaultLayer),
  Layer.provide(runtime),
  Layer.provideMerge(agentMode),
  Layer.provideMerge(todo),
  Layer.provideMerge(question),
  Layer.provideMerge(deps),
)
const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))

function makePrompt(input?: { processor?: "blocking" }) {
  const proc =
    input?.processor === "blocking"
      ? blockingProcessor
      : SessionProcessor.layer.pipe(
          Layer.provide(summary),
          Layer.provide(Image.defaultLayer),
          Layer.provide(runtime),
          Layer.provide(ExitQueue.defaultLayer),
          Layer.provideMerge(deps),
        )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(runtime),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return SessionPrompt.layer.pipe(
    Layer.provide(sessionRevert),
    Layer.provide(Image.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(agentMode),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(instruction),
    Layer.provide(systemPrompt),
    Layer.provide(runtime),
    Layer.provideMerge(SessionSnip.layer),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

function makeHttp(input?: { processor?: "blocking" }) {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt(input))
}

function makeHttpNoLLMServer(input?: { processor?: "blocking" }) {
  return makePrompt(input)
}

export const it = testEffect(makeHttp())

export const noLLMServer = testEffect(makeHttpNoLLMServer())

export const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))

export const unix = process.platform !== "win32" ? it.instance : it.instance.skip

export const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

export const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

export function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

export const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const ensureDir = Effect.fn("test.ensureDir")(function* (dir: string) {
  const fs = yield* FSUtil.Service
  yield* fs.ensureDir(dir)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "deveco.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

export const useServerConfig = Effect.fn("test.useServerConfig")(function* (
  config: (url: string) => Partial<ConfigV1.Info>,
) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

export const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})
