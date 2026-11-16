import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import { AgentRules } from "@/agent/rules"
import { AgentPromptParts, agentNeedsHomegraphPrompt } from "@/agent/prompt-parts"
import { probeHomegraphReady } from "@/mcp/homegraph-ready"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Runtime } from "@opencode-ai/core/runtime"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `deveco/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, unknown>
  }
  readonly messageTransformOptions: Record<string, unknown>
  readonly headers: Record<string, string>
}

const mergeOptions = (
  target: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
): Record<string, unknown> => mergeDeep(target, source ?? {}) as Record<string, unknown>

function buildSystemParts(
  input: PrepareInput,
  homegraph: { ready: boolean; source?: "product" | "user" },
): string[] {
  return [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      ...AgentPromptParts.forAgent(input.agent, {
        homegraphReady: homegraph.ready,
        homegraphSource: homegraph.source,
      }),
      ...AgentRules.forAgent(input.model, input.agent),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]
}

function collapseSystemAfterTransform(system: string[], header: string): void {
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }
}

function buildProviderOptions(input: PrepareInput, system: string[], isOpenaiOauth: boolean): Record<string, unknown> {
  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")
  return options
}

function buildMessages(input: PrepareInput, system: string[], isOpenaiOauth: boolean): ModelMessage[] {
  if (isOpenaiOauth || input.isWorkflow) return input.messages
  return [
    ...system.map(
      (x): ModelMessage => ({
        role: "system",
        content: x,
      }),
    ),
    ...input.messages,
  ]
}

function ensureCopilotNoopTool(input: PrepareInput, tools: Record<string, Tool>): void {
  if (
    !input.model.providerID.includes("github-copilot") ||
    Object.keys(tools).length !== 0 ||
    !hasToolCalls(input.messages)
  ) {
    return
  }
  // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
  tools._noop = aiTool({
    description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        reason: { type: "string", description: "Unused" },
      },
    }),
    execute: async () => ({ output: "", title: "", metadata: {} }),
  })
}

export function devecoAffinityHeaders(
  input: { sessionID: string; parentSessionID?: string; messageID: string },
  projectID: string | undefined,
): Record<string, string> {
  const source = Runtime.current.analyticsSource
  const pluginVersion = process.env.DEVECO_PLUGIN_VERSION?.trim() ?? "unknown"
  return {
    ...(projectID ? { "x-deveco-project": projectID } : {}),
    "x-deveco-session": input.sessionID,
    ...(input.parentSessionID ? { "x-deveco-parent-session": input.parentSessionID } : {}),
    "x-deveco-task": input.messageID,
    "x-deveco-client":
      source.sourceType === "DevEco-Code-Plugin"
        ? `deveco-code-plugin@${pluginVersion}`
        : `deveco-code@${InstallationVersion}`,
    "User-Agent": USER_AGENT,
  }
}

function affinityHeaders(input: PrepareInput, projectID: string | undefined): Record<string, string> {
  if (input.model.providerID.startsWith("opencode")) {
    return {
      ...(projectID ? { "x-opencode-project": projectID } : {}),
      "x-opencode-session": input.sessionID,
      "x-opencode-request": input.user.id,
      "x-opencode-client": input.flags.client,
      "User-Agent": USER_AGENT,
    }
  }
  if (input.model.providerID.startsWith("deveco")) {
    return devecoAffinityHeaders(
      { sessionID: input.sessionID, parentSessionID: input.parentSessionID, messageID: input.user.id },
      projectID,
    )
  }
  return {
    "x-session-affinity": input.sessionID,
    "X-Session-Id": input.sessionID,
    ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
    "User-Agent": USER_AGENT,
  }
}

function defaultChatParams(input: PrepareInput, options: Record<string, unknown>) {
  return {
    temperature: input.model.capabilities.temperature
      ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
      : undefined,
    topP: input.agent.topP ?? ProviderTransform.topP(input.model),
    topK: ProviderTransform.topK(input.model),
    maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
    options,
  }
}

function pluginChatContext(input: PrepareInput) {
  return {
    sessionID: input.sessionID,
    agent: input.agent.name,
    model: input.model,
    provider: input.provider,
    message: input.user,
  }
}

function sortedTools(tools: Record<string, Tool>): Record<string, Tool> {
  return Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b)))
}

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  // Skip readiness probe for agents that never inject the HG prompt part.
  const homegraph = agentNeedsHomegraphPrompt(input.agent.name)
    ? yield* probeHomegraphReady
    : { ready: false as const, source: undefined }

  const system = buildSystemParts(input, homegraph)
  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  collapseSystemAfterTransform(system, header)

  const options = buildProviderOptions(input, system, isOpenaiOauth)
  const messages = buildMessages(input, system, isOpenaiOauth)
  const ctx = pluginChatContext(input)
  const params = yield* input.plugin.trigger("chat.params", ctx, defaultChatParams(input, options))
  const { headers } = yield* input.plugin.trigger("chat.headers", ctx, { headers: {} })

  const tools = resolveTools(input)
  ensureCopilotNoopTool(input, tools)

  const needsProject =
    input.model.providerID.startsWith("opencode") || input.model.providerID.startsWith("deveco")
  const projectID = needsProject ? (yield* InstanceState.context).project.id : undefined

  return {
    system,
    messages,
    tools: sortedTools(tools),
    params,
    messageTransformOptions: options,
    headers: { ...affinityHeaders(input, projectID), ...input.model.headers, ...headers },
  }
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
