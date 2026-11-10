import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema, LoggingMessageNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { resolveVendorDir } from "@opencode-ai/core/installation/vendor-path"
import { DEVECO_API_URL, getTaskDefaultModelMap } from "@/plugin/deveco-models"
import { requireDevEcoAccess } from "@/plugin/deveco/access"
import { globalCollector } from "@/plugin/analytics/collector"
import { createEnvironmentFields } from "@/plugin/analytics/events"
import { getVersion } from "@/plugin/analytics/storage"
import { flushAnalyticsEvents, uploadAnalyticsEvent } from "@/plugin/analytics/uploader"
import { ANALYTICS_ACTION, type UiVerificationOperationDetail } from "@/plugin/analytics/types"
import { Session } from "@/session/session"
import { Effect, Schema } from "effect"
import { z } from "zod"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { findDevEcoHome, hdcPath, nodePath } from "../lib/env"
import { getSessionCwd } from "../lib/session-cwd"
import { define, type Context, type ExecuteResult } from "../tool"


const VerifyUiParameters = Schema.Struct({
  bundleName: Schema.optional(Schema.String).annotate({
    description: "待测试的应用包名，不填写时自动从项目中获取",
  }),
  device: Schema.optional(Schema.String).annotate({
    description: "接受设备名称（支持子串匹配）或序列号（例如 127.0.0.1:5555）；仅连接一台设备时自动选中，多设备环境下必须指定。",
  }),
  testPlan: Schema.String.annotate({
    description: "自然语言描述的测试用例计划，包括每步的步骤以及预期结果",
  }),
  freshStart: Schema.optional(Schema.Boolean).annotate({
    description: "是否在测试前重新启动应用",
  }),
})

const GetLogParameters = Schema.Struct({
  id: Schema.String.annotate({
    description: "校验ID",
  }),
  maxLogSize: Schema.optional(Schema.Number).annotate({
    description: "可选的日志总字符数限制：默认为5000字符；传-1代表不限制字符数",
  }),
  searchKeywords: Schema.optional(Schema.String).annotate({
    description: "可选的日志搜索关键词。若需要获取完整日志内容，请传空字符串。",
  }),
})

const SaveScreenshotParameters = Schema.Struct({
  id: Schema.String.annotate({
    description: "verify_ui 工具返回的校验任务 ID",
  }),
  dirname: Schema.String.annotate({
    description: "截图保存目录，必须为绝对路径",
  }),
})

type UiVerifyParams = {
  baseURL: string | null
  apiKey: string | null
  modelName: string | null
}

type DevicePrefix = "emulator" | "physical"

type ToolName = "verify_ui" | "get_ui_verification_log" | "save_ui_screenshot"

type RuntimeState = {
  client: Client
  transport: StdioClientTransport
  schemaProperties: Map<string, Set<string>>
  params: UiVerifyParams
  hdcPath?: string
}

// Tool result metadata consumed by the analytics plugin's tool.execute.after hook
// (see plugin/analytics/analytics-plugin.ts). `uiVerificationModel` is the model the
// ui-verification MCP child is actually bound to; null means no model call happened.
type UiVerifyMetadata = { id?: string; uiVerificationModel?: string | null }

const TOOL_NAME_MAP: Record<ToolName, string> = {
  verify_ui: "verifyUI",
  get_ui_verification_log: "getLog",
  save_ui_screenshot: "saveScreenshot",
}

const MISSING_MODEL_MESSAGE =
  "工具调用失败。请将以下内容原文告知用户，不要修改或补充：「UI 意图校验功能不可用：未配置多模态模型。请在配置文件中为 ui_verification agent 配置一个支持多模态的模型，或登录账号以使用内置多模态模型。」"

let gate: Promise<void> = Promise.resolve()
let verifyRunGate: Promise<void> = Promise.resolve()
let bound = ""
let runtime: RuntimeState | undefined
let activeRunMetrics: VerifyRunMetrics | undefined

const TracingNotificationSchema = z.object({
  method: z.literal("notifications/tracing"),
  params: z.record(z.string(), z.unknown()),
})

export const VerifyUiTool: ReturnType<
  typeof define<typeof VerifyUiParameters, UiVerifyMetadata, Session.Service, "verify_ui">
> = define<typeof VerifyUiParameters, UiVerifyMetadata, Session.Service, "verify_ui">(
  "verify_ui",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "在提供自然语言描述的功能步骤之后，本工具可以在HarmonyOS设备上运行应用，根据截图进行判断，执行UI操作，验证功能是否可以正确完成。\n注意：当前支持点击、双击、滑动、长按、按键等触控操作，以及鼠标和键盘操作。支持在步骤中通过 URI 直接跳转到指定页面；使用 URI 跳转时，必须在测试步骤中提供完整、明确且可直接执行的 URI，不能只描述目标页面或省略 URI 内容。\n返回的successPart、failPart字段描述了本次验证过程的主要步骤，id字段是本次校验的唯一标识符，可用于后续的日志查询。failType 为失败类型：空字符串表示验证通过；verification_failed 表示在工具能力范围内步骤未按预期完成；unsupported 表示关键操作超出工具能力（声音、触觉、对帧间持续移动的目标操作）；invalid_plan 表示计划不规范或当前设备无法执行；execution_error 表示模型、设备或服务中断，没有验证结论；inconclusive 表示证据不足，无法区分验证失败与工具不支持，包括达到轮数上限。旧引擎不返回 failType。\n使用场景：\n1. 开发时验证：通过自然语言描述测试用例，自动执行UI操作，验证应用功能。\n2. 获取运行时日志：配合getLog工具使用，在执行UI操作的同时，收集设备日志，帮助定位问题。\n3. 保存截图：配合saveScreenshot工具使用，在执行UI操作的同时，保存截图，帮助定位问题。",
      parameters: VerifyUiParameters,
      execute: (args, ctx): Effect.Effect<ExecuteResult<UiVerifyMetadata>> =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "verify_ui", metadata: {}, patterns: ["*"], always: ["*"] })
          return yield* Effect.promise(() => executeVerifyUi(args, ctx, sessions))
        }).pipe(Effect.orDie),
    }
  }),
)

export const GetUiVerificationLogTool: ReturnType<
  typeof define<typeof GetLogParameters, Record<string, never>, Session.Service, "get_ui_verification_log">
> = define<typeof GetLogParameters, Record<string, never>, Session.Service, "get_ui_verification_log">(
  "get_ui_verification_log",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description: "根据校验ID获取对应的设备运行日志",
      parameters: GetLogParameters,
      execute: (args, ctx): Effect.Effect<ExecuteResult<Record<string, never>>> =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "get_ui_verification_log", metadata: {}, patterns: ["*"], always: ["*"] })
          return yield* Effect.promise(() => executeGetUiVerificationLog(args, ctx, sessions))
        }).pipe(Effect.orDie),
    }
  }),
)

export const SaveUiScreenshotTool: ReturnType<
  typeof define<typeof SaveScreenshotParameters, Record<string, never>, Session.Service, "save_ui_screenshot">
> = define<typeof SaveScreenshotParameters, Record<string, never>, Session.Service, "save_ui_screenshot">(
  "save_ui_screenshot",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description: "根据校验ID保存某次校验的每一步截图，返回截图文件名列表",
      parameters: SaveScreenshotParameters,
      execute: (args, ctx): Effect.Effect<ExecuteResult<Record<string, never>>> =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "save_ui_screenshot", metadata: {}, patterns: ["*"], always: ["*"] })
          return yield* Effect.promise(() => executeSaveUiScreenshot(args, ctx, sessions))
        }).pipe(Effect.orDie),
    }
  }),
);

async function executeVerifyUi(
  args: Schema.Schema.Type<typeof VerifyUiParameters>,
  ctx: Context,
  sessions: Session.Interface,
): Promise<ExecuteResult> {
  const worktree = await resolveWorktree(ctx, sessions)
  const detail: UiVerificationOperationDetail = {
    subAction: "run",
    freshStart: args.freshStart ?? false,
    planLen: Array.from(args.testPlan).length,
  }
  let metrics: VerifyRunMetrics | undefined
  const devicePrefix: { value?: DevicePrefix } = {}
  try {
    if (await isBoundDevecoOauthExpired(worktree)) await ensureInitialized(worktree)
    const params = await resolveUIVerifyParams(worktree)
    if (!params.baseURL || !params.apiKey || !params.modelName) {
      return await reportMissingModel(ctx, detail)
    }

    metrics = new VerifyRunMetrics()
    return await runVerifyUiAttempt(args, ctx, worktree, detail, params, metrics, devicePrefix)
  } catch (error) {
    if (metrics) {
      Object.assign(detail, metrics.snapshot())
      const deviceType = resolveDeviceType(metrics.deviceInfo())
      if (deviceType) detail.deviceType = deviceType
    }
    if (devicePrefix.value) detail.deviceCategory = devicePrefix.value
    await reportUiVerificationOperation(ctx, detail)
    throw error
  }
}

async function runVerifyUiAttempt(
  args: Schema.Schema.Type<typeof VerifyUiParameters>,
  ctx: Context,
  worktree: string,
  detail: UiVerificationOperationDetail,
  params: UiVerifyParams,
  metrics: VerifyRunMetrics,
  devicePrefix: { value?: DevicePrefix },
): Promise<ExecuteResult> {
  const bundleName = args.bundleName ?? (await readBundleName(worktree))
  detail.bundleName = bundleName
  await ensureInitialized(worktree)
  const boundModel = runtime?.params.modelName ?? params.modelName
  if (boundModel?.trim()) detail.modelName = normalizeModelName(boundModel)
  devicePrefix.value = await resolveUiVerificationDeviceType(args.device, runtime?.hdcPath)
  if (devicePrefix.value) detail.deviceCategory = devicePrefix.value

  const payload = {
    bundleName,
    ...(args.device ? { device: args.device } : {}),
    testPlan: args.testPlan,
    freshStart: args.freshStart ?? false,
    sessionId: ctx.sessionID,
  }
  const result = await runVerifyUiExclusive(metrics, () => callUiVerificationTool(worktree, "verify_ui", payload, ctx.abort, metrics))
  const parsed = readVerifyResult(result)
  Object.assign(detail, metrics.snapshot(), parsed.detail)
  // 形态在 run 过程中由引擎 tracing 上报（折叠细分类型优先于 devicetype 静态值），结束时组合
  const deviceType = resolveDeviceType(metrics.deviceInfo())
  if (deviceType) detail.deviceType = deviceType
  await reportUiVerificationOperation(ctx, detail)
  return verifyUiSuccessResult(result, parsed)
}

function verifyUiSuccessResult(
  result: unknown,
  parsed: { id?: string; detail: Partial<UiVerificationOperationDetail> },
): ExecuteResult {
  // Report what the MCP child is actually bound to. `resolveUIVerifyParams` above
  // is only a pre-check: ensureInitialized() reuses an already-started child when
  // the binding is still valid, so a config hot-reload can leave runtime.params
  // (the values written into the child's UI_VERIFY_* env) different from `params`.
  const metadata: UiVerifyMetadata = { uiVerificationModel: runtime?.params.modelName ?? null }
  if (parsed.id) metadata.id = parsed.id
  return { title: "UI verification", output: textFromCallResult(result), metadata }
}

async function reportMissingModel(ctx: Context, detail: UiVerificationOperationDetail): Promise<ExecuteResult> {
  await reportUiVerificationOperation(ctx, detail)
  // Unresolvable credentials/params: no model was called, so report no model
  // rather than the absent config value.
  return {
    title: "UI verification unavailable",
    output: MISSING_MODEL_MESSAGE,
    metadata: { uiVerificationModel: null },
  }
}

async function executeGetUiVerificationLog(
  args: Schema.Schema.Type<typeof GetLogParameters>,
  ctx: Context,
  sessions: Session.Interface,
): Promise<ExecuteResult<Record<string, never>>> {
  const worktree = await resolveWorktree(ctx, sessions)
  try {
    const result = await callUiVerificationTool(worktree, "get_ui_verification_log", {
      id: args.id,
      ...(args.maxLogSize === undefined ? {} : { maxLogSize: args.maxLogSize }),
      ...(args.searchKeywords === undefined ? {} : { searchKeywords: args.searchKeywords }),
    }, ctx.abort)
    return { title: "UI verification log", output: textFromCallResult(result), metadata: {} }
  } finally {
    await reportUiVerificationOperation(ctx, { subAction: "log" })
  }
}

async function executeSaveUiScreenshot(
  args: Schema.Schema.Type<typeof SaveScreenshotParameters>,
  ctx: Context,
  sessions: Session.Interface,
): Promise<ExecuteResult<Record<string, never>>> {
  const worktree = await resolveWorktree(ctx, sessions)
  try {
    const result = await callUiVerificationTool(worktree, "save_ui_screenshot", {
      id: args.id,
      dirname: sanitizeFilePath(args.dirname, worktree),
    }, ctx.abort)
    return { title: "UI screenshots", output: textFromCallResult(result), metadata: {} }
  } finally {
    await reportUiVerificationOperation(ctx, { subAction: "screenshot" })
  }
}

async function reportUiVerificationOperation(
  ctx: Context,
  detail: UiVerificationOperationDetail,
): Promise<void> {
  try {
    if (!(await globalCollector.shouldCollect())) return
    const accepted = await uploadAnalyticsEvent({
      action: ANALYTICS_ACTION.UI_VERIFICATION,
      event: {
        ...createEnvironmentFields(getVersion()),
        sessionid: ctx.sessionID,
        messageId: ctx.messageID,
        event_detail: detail,
      },
    })
    if (accepted) void flushAnalyticsEvents().catch(() => undefined)
  } catch {
    // Telemetry must never affect the tool result.
  }
}

async function runVerifyUiExclusive<T>(metrics: VerifyRunMetrics, fn: () => Promise<T>): Promise<T> {
  const run = verifyRunGate.then(runWithMetrics, runWithMetrics)
  verifyRunGate = run.then(
    () => undefined,
    () => undefined,
  )
  return run

  async function runWithMetrics(): Promise<T> {
    const startedAt = Date.now()
    try {
      return await fn()
    } finally {
      metrics.recordToolDuration(Date.now() - startedAt)
      if (activeRunMetrics === metrics) activeRunMetrics = undefined
    }
  }
}

async function resolveWorktree(ctx: Context, sessions: Session.Interface): Promise<string> {
  const sessionCwd = getSessionCwd(ctx.sessionID)
  if (sessionCwd) {
    return sessionCwd;
  }
  const session = await Effect.runPromise(sessions.get(ctx.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined))))
  return session?.directory ?? process.cwd();
}

export async function resolveUIVerifyParams(worktree: string): Promise<UiVerifyParams> {
  try {
    const { Effect } = await import("effect")
    const { AppRuntime } = await import("@/effect/app-runtime")
    const { Config } = await import("@/config/config")
    const { Provider } = await import("@/provider/provider")
    const { InstanceStore } = await import("@/project/instance-store")
    const result = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: worktree },
          Effect.gen(function* () {
            const config = yield* Config.Service
            const cfg = yield* config.get()
            const modelStr = cfg.agent?.["ui_verification"]?.model
            if (!modelStr) return null
            const { providerID, modelID } = Provider.parseModel(modelStr)
            const svc = yield* Provider.Service
            const provider = yield* svc.getProvider(providerID).pipe(Effect.catch(() => Effect.succeed(null)))
            const model = yield* svc.getModel(providerID, modelID).pipe(Effect.catch(() => Effect.succeed(null)))
            if (!provider || !model) return null
            return {
              baseURL: (provider.options?.baseURL as string | undefined) ?? model.api.url ?? null,
              apiKey: providerID === "deveco"
                ? yield* Effect.promise(() => requireDevEcoAccess(cfg.agreement))
                : provider.key ?? (provider.options?.apiKey as string | undefined) ?? null,
              modelName: model.api.id ?? null,
            }
          }),
        ),
      ),
    )
    if (result) {
      return result;
    }
  } catch {}

  if (process.env.UI_VERIFY_BASE_URL && process.env.UI_VERIFY_API_KEY && process.env.UI_VERIFY_MODEL_NAME) {
    return {
      baseURL: process.env.UI_VERIFY_BASE_URL,
      apiKey: process.env.UI_VERIFY_API_KEY,
      modelName: process.env.UI_VERIFY_MODEL_NAME,
    }
  }

  try {
    const access = await requireDevEcoAccess()
    return {
      baseURL: DEVECO_API_URL + "/no-stream",
      apiKey: access,
      modelName: getTaskDefaultModelMap()?.["ui_verification"] ?? "Qwen3_5_397B_A17B_w8a8_single",
    }
  } catch {}

  return { baseURL: null, apiKey: null, modelName: null };
}

async function ensureInitialized(worktree: string): Promise<void> {
  gate = gate.catch(() => {}).then(async () => {
    if (bound === worktree && runtime) {
      if (runtime.params.baseURL?.startsWith(DEVECO_API_URL)) {
        const access = await requireDevEcoAccess().catch(() => undefined)
        if (access && access === runtime.params.apiKey) return
      } else if (runtime.params.baseURL && runtime.params.apiKey && runtime.params.modelName) {
        return
      }
    }
    bound = worktree
    await startUiVerificationMcp(worktree)
  })
  await gate;
}

async function isBoundDevecoOauthExpired(worktree: string): Promise<boolean> {
  if (bound !== worktree || !runtime?.params.baseURL?.startsWith(DEVECO_API_URL)) return false
  // Lost access invalidates the binding; rebuilding resolves the current provider.
  const access = await requireDevEcoAccess().catch(() => undefined)
  return !access || access !== runtime.params.apiKey
}

async function startUiVerificationMcp(worktree: string): Promise<void> {
  await stopUiVerificationMcp()
  bound = worktree
  const devecoHome = await findDevEcoHome()
  const verifiedHdcPath = await resolveVerifiedHdcPath(devecoHome)
  const effectiveHdcPath = verifiedHdcPath ?? process.env.UI_VERIFY_HDC_PATH ?? process.env.RC_HDC_PATH ?? "hdc"
  const logDir = uiVerificationLogDir()
  fs.mkdirSync(logDir, { recursive: true })
  const params = await resolveUIVerifyParams(worktree)
  const script = resolveUiVerificationScript()
  const { AppRuntime } = await import("@/effect/app-runtime")
  await AppRuntime.runPromise(Effect.logInfo("ui_verification model", { service: "ui-verification", baseURL: params.baseURL, modelName: params.modelName }))

  const transport = new StdioClientTransport({
    command: devecoHome ? nodePath(devecoHome) : "node",
    args: [script, logDir],
    cwd: worktree,
    stderr: "ignore",
    env: {
      ...processEnv(verifiedHdcPath ? [] : ["UI_VERIFY_HDC_PATH"]),
      LOG_PATH: logDir,
      ...(verifiedHdcPath ? { UI_VERIFY_HDC_PATH: verifiedHdcPath } : {}),
      UI_VERIFY_BASE_URL: params.baseURL ?? "",
      UI_VERIFY_API_KEY: params.apiKey ?? "",
      UI_VERIFY_MODEL_NAME: params.modelName ?? "",
    },
  })
  const client = await createUiVerificationClient(transport)
  const listed = await client.listTools()
  runtime = {
    params,
    client,
    transport,
    hdcPath: effectiveHdcPath,
    schemaProperties: buildSchemaProperties(listed.tools),
  };
}

async function resolveVerifiedHdcPath(devecoHome: string | undefined): Promise<string | undefined> {
  const resolved = devecoHome ? hdcPath(devecoHome) : undefined
  return resolved && (await Bun.file(resolved).exists()) ? resolved : undefined
}

async function createUiVerificationClient(transport: StdioClientTransport): Promise<Client> {
  const client = new Client({ name: "deveco-ui-verification", version: "1.0.0" })
  await client.connect(transport)
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    const data = notification.params.data
    const message = data && typeof data === "object" ? (data as { message?: unknown }).message : undefined
    if (typeof message === "string") activeRunMetrics?.recordLogMessage(message)
  })
  client.setNotificationHandler(TracingNotificationSchema, (notification) => {
    activeRunMetrics?.recordTracingMessage(notification.params)
  })
  return client
}

function buildSchemaProperties(tools: Tool[]): Map<string, Set<string>> {
  return new Map(
    tools.map((item) => {
      const properties = item.inputSchema?.properties
      return [item.name, new Set(properties && typeof properties === "object" ? Object.keys(properties) : [])]
    }),
  )
}

// Allowlist of inherited env vars passed to the ui-verification-mcp child process.
// The child only needs PATH/system vars to spawn hdc/node, DEVECO_HOME/DEVECO_PATH
// to locate DevEco Studio, the RC_* legacy fallbacks it reads, and its UI_VERIFY_*
// config flags. Secrets such as DEVECO_API_KEY or third-party provider keys must NOT
// leak through. Windows env vars are case-insensitive, so matching is upper-cased.
const ENV_ALLOWLIST = new Set(
  [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "ComSpec",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "LANG",
    "LC_ALL",
    "LC_MESSAGES",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SHELL",
    "USER",
    "LOGNAME",
    "NODE_OPTIONS",
    "DEVECO_HOME",
    "DEVECO_PATH",
    "RC_HDC_PATH",
    "RC_API_KEY",
    "RC_BASE_URL",
    "RC_MODEL_NAME",
  ].map((k) => k.toUpperCase()),
);

const ENV_PREFIX_ALLOWLIST = ["UI_VERIFY_"];

function isEnvAllowed(name: string): boolean {
  const upper = name.toUpperCase();
  if (ENV_PREFIX_ALLOWLIST.some((p) => upper.startsWith(p))) {
    return true;
  }
  return ENV_ALLOWLIST.has(upper);
}

function processEnv(omit: string[] = []): Record<string, string> {
  const omitted = new Set(omit);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !omitted.has(entry[0]) && isEnvAllowed(entry[0]),
    ),
  );
}

async function callUiVerificationTool(
  worktree: string,
  toolName: ToolName,
  args: Record<string, unknown>,
  signal: AbortSignal,
  metrics?: VerifyRunMetrics,
): Promise<unknown> {
  await ensureInitialized(worktree)
  if (!runtime) {
    throw new Error('ui-verification-mcp is not initialized');
  }
  if (metrics) activeRunMetrics = metrics
  const name = TOOL_NAME_MAP[toolName]
  return await runtime.client.callTool(
    {
      name,
      arguments: filterArguments(name, args),
    },
    CallToolResultSchema,
    {
      resetTimeoutOnProgress: true,
      signal,
      timeout: 30 * 60 * 1000,
      ...(metrics ? { onprogress: (progress: { progress: number }) => metrics.recordProgress(progress.progress) } : {}),
    },
  );
}

export async function stopUiVerificationMcp(): Promise<void> {
  const current = runtime
  runtime = undefined
  bound = ""
  activeRunMetrics = undefined
  if (!current) {
    return;
  }
  try {
    await current.client.close();
  } catch {}
}

function filterArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const properties = runtime?.schemaProperties.get(toolName)
  if (!properties || properties.size === 0) {
    return args;
  }
  if (args.device !== undefined && !properties.has("device")) {
    throw new Error("The installed ui-verification-mcp package does not support the device parameter.")
  }
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => properties.has(key) || (toolName === 'verifyUI' && key === 'sessionId')),
  );
}

function uiVerificationLogDir(): string {
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share", "deveco"),
    "log",
    "deveco-mcp",
    "uiVerificationLog",
  );
}

function resolveUiVerificationScript(): string {
  const execDir = path.dirname(process.execPath)
  const vendor = path.join(resolveVendorDir(), "ui-verification-mcp", "uiVerification.mjs")
  if (fs.existsSync(vendor)) {
    return vendor;
  }

  const legacy = path.join(execDir, "ui-verification-mcp", "uiVerification.mjs")
  if (fs.existsSync(legacy)) {
    return legacy;
  }

  const pkgJson = createRequire(import.meta.url).resolve("ui-verification-mcp/package.json")
  return path.join(path.dirname(pkgJson), "dist", "uiVerification.mjs");
}

function textFromCallResult(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(result, null, 2)
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return JSON.stringify(result, null, 2);
  }
  const text = content
    .map((item) =>
      item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join('\n')
  return text || JSON.stringify(result, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function readVerifyResult(result: unknown): { id?: string; detail: Partial<UiVerificationOperationDetail> } {
  try {
    const parsed: unknown = JSON.parse(textFromCallResult(result))
    if (!isRecord(parsed)) return { detail: {} }
    const detail: Partial<UiVerificationOperationDetail> = {}
    if (typeof parsed.success === "boolean") detail.verificationSuccess = parsed.success
    if (parsed.failType === null || typeof parsed.failType === "string") detail.failType = parsed.failType
    return {
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
      detail,
    }
  } catch {
    return { detail: {} }
  }
}

const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const TOKEN_LINE_PATTERN = /Prompt tokens:\s*([^,]+),\s*Completion tokens:\s*([^,]+),\s*Total tokens:\s*(\S+)/
const USAGE_JSON_PATTERN = /usage:\s*(\{.*?\})/

export function normalizeModelName(name: unknown): string {
  if (typeof name !== "string") return "unknown"
  const normalized = name.trim().slice(0, 64)
  return normalized === "" ? "unknown" : normalized
}

export function normalizeToolName(name: unknown): string {
  if (typeof name !== "string") return "other"
  const normalized = name.trim().toLowerCase()
  return TOOL_NAME_PATTERN.test(normalized) ? normalized : "other"
}

export function normalizeDeviceForm(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return normalized === "" ? undefined : normalized
}

export function resolveDeviceType(info: { deviceTypeForm?: string; foldableType?: string }): string | undefined {
  return info.foldableType ?? info.deviceTypeForm
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null
}

function asTokenCount(value: unknown): number | null {
  const count = typeof value === "number" ? value : Number(value)
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null
}

export class VerifyRunMetrics {
  private stepExecuted = 0
  private stepTotalDurationMs = 0
  private stepReused: number | null = null
  private readonly toolUsageDist: Record<string, number> = {}
  private screenshotCount = 0
  private tokenUsage = 0
  private hasTokenUsage = false
  private deviceTypeForm: string | undefined
  private foldableType: string | undefined
  private deeplinkUsed = false

  recordProgress(progress: number): void {
    if (!Number.isInteger(progress) || progress < 0) return
    this.stepExecuted = Math.max(this.stepExecuted, progress)
  }

  recordToolDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    this.stepTotalDurationMs = durationMs
  }

  recordTracingMessage(message: Record<string, unknown>): void {
    if (typeof message.event !== "string") return
    if (message.event === "UI_VERIFICATION_TOOL_USAGE") {
      const inner = message.innerToolUsage
      const toolName = typeof message.toolName === "string" ? message.toolName : isRecord(inner) ? inner.toolName : undefined
      const tool = normalizeToolName(toolName)
      this.toolUsageDist[tool] = (this.toolUsageDist[tool] ?? 0) + 1
      return
    }
    if (message.event === "UI_VERIFICATION_SCREENSHOT_COUNT") {
      const count = asNonNegativeInt(message.screenshot_count)
      if (count !== null) this.screenshotCount += count
      return
    }
    if (message.event === "UI_VERIFICATION_HISTORY_REUSED") {
      const reused = asNonNegativeInt(message.reused_steps)
      if (reused !== null) this.stepReused = reused
      return
    }
    if (message.event === "UI_VERIFICATION_DEVICE_INFO") {
      this.deviceTypeForm = normalizeDeviceForm(message.device_type)
      this.foldableType = normalizeDeviceForm(message.foldable_type)
      return
    }
    if (message.event === "UI_VERIFICATION_DEEPLINK_USED") {
      this.deeplinkUsed = true
    }
  }

  recordLogMessage(message: string): void {
    const tokenLine = TOKEN_LINE_PATTERN.exec(message)
    if (tokenLine) {
      this.accumulateTokens(tokenLine[3], tokenLine[1], tokenLine[2])
      return
    }
    const usageJson = USAGE_JSON_PATTERN.exec(message)
    if (!usageJson) return
    try {
      const usage: unknown = JSON.parse(usageJson[1])
      if (!isRecord(usage)) return
      this.accumulateTokens(usage.total_tokens, usage.prompt_tokens, usage.completion_tokens)
    } catch {
      // Ignore malformed engine logs.
    }
  }

  deviceInfo(): { deviceTypeForm?: string; foldableType?: string } {
    return { deviceTypeForm: this.deviceTypeForm, foldableType: this.foldableType }
  }

  snapshot() {
    return {
      stepExecuted: this.stepExecuted,
      stepTotalDurationMs: this.stepTotalDurationMs,
      stepReused: this.stepReused,
      toolUsageDist: { ...this.toolUsageDist },
      screenshotCount: this.screenshotCount,
      ...(this.hasTokenUsage ? { tokenUsage: this.tokenUsage } : {}),
      ...(this.deeplinkUsed ? { deeplinkUsed: true } : {}),
    }
  }

  private accumulateTokens(total: unknown, prompt: unknown, completion: unknown): void {
    const totalCount = asTokenCount(total)
    if (totalCount !== null) {
      this.tokenUsage += totalCount
      this.hasTokenUsage = true
      return
    }
    const promptCount = asTokenCount(prompt)
    const completionCount = asTokenCount(completion)
    if (promptCount === null && completionCount === null) return
    this.tokenUsage += (promptCount ?? 0) + (completionCount ?? 0)
    this.hasTokenUsage = true
  }
}

async function resolveUiVerificationDeviceType(
  selector: string | undefined,
  hdc: string | undefined,
): Promise<DevicePrefix | undefined> {
  if (!hdc) return undefined
  try {
    const serials = await listHdcSerials(hdc)
    if (!selector) return serials.length === 1 ? deviceTypeFromSerial(serials[0]) : undefined
    const exact = serials.find((serial) => serial === selector)
    if (exact) return deviceTypeFromSerial(exact)
    const needle = selector.toLowerCase()
    const named = await Promise.all(
      serials.map(async (serial) => ({ serial, name: await fetchHdcDeviceName(hdc, serial) })),
    )
    const matches = named.filter((device) => device.name.toLowerCase().includes(needle))
    return matches.length === 1 ? deviceTypeFromSerial(matches[0].serial) : undefined
  } catch {
    return undefined
  }
}

function deviceTypeFromSerial(serial: string): DevicePrefix {
  return serial.startsWith("127.0.0.1:") ? "emulator" : "physical"
}

async function listHdcSerials(hdc: string): Promise<string[]> {
  const output = await runHdcCommand(hdc, ["list", "targets"])
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((serial): serial is string => !!serial && !serial.startsWith("[Empty]"))
}

async function fetchHdcDeviceName(hdc: string, serial: string): Promise<string> {
  const qemuName = await readHdcDeviceParam(hdc, serial, "ohos.qemu.hvd.name")
  if (qemuName) return qemuName
  const productName = await readHdcDeviceParam(hdc, serial, "const.product.name")
  if (productName && productName !== "emulator") return productName
  const model = await readHdcDeviceParam(hdc, serial, "const.product.model")
  if (model && model !== "emulator") {
    const brand = await readHdcDeviceParam(hdc, serial, "const.product.brand")
    return stripBrandPrefix(model, brand)
  }
  return serial
}

async function readHdcDeviceParam(hdc: string, serial: string, key: string): Promise<string> {
  try {
    const value = (await runHdcCommand(hdc, ["-t", serial, "shell", "param", "get", key])).trim()
    return value.includes("errNum") ? "" : value
  } catch {
    return ""
  }
}

function stripBrandPrefix(model: string, brand: string): string {
  if (!brand) return model
  const stripped = model.replace(new RegExp(`^${escapeRegExp(brand)}(?:\\s+|[-_]+)?`, "i"), "").trim()
  return stripped || model
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function runHdcCommand(hdc: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([hdc, ...args], { stdout: "pipe", stderr: "ignore", timeout: 5000 })
  const output = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`hdc ${args.join(" ")} exited with ${exitCode}`)
  return output
}

async function readBundleName(worktree: string): Promise<string> {
  const project = await findHarmonyProject(worktree)
  const appJson = path.join(project, "AppScope", "app.json5")
  const content = await fs.promises.readFile(appJson, "utf8")
  const match = /"bundleName"\s*:\s*"([^"]+)"/.exec(content)
  if (!match?.[1]) {
    throw new Error("bundleName 未填写，自动从 AppScope/app.json5 获取失败: bundleName not found")
  }
  return match[1];
}

async function findHarmonyProject(start: string): Promise<string> {
  const root = path.resolve(start)
  const stat = await fs.promises.stat(root).catch(() => undefined)
  if (!stat) throw new Error(`The path does not exist: ${root}`)
  const initial = stat.isDirectory() ? root : path.dirname(root)
  if (isHarmonyProject(initial)) return initial
  const found = searchHarmonyProject(initial, 0, 3)
  if (found) {
    return found;
  }
  throw new Error(`在路径 '${initial}' 及其子目录中未找到 Harmony 工程。`);
}

function searchHarmonyProject(current: string, depth: number, maxDepth: number): string | undefined {
  if (depth >= maxDepth) {
    return undefined;
  }
  const entries = fs.readdirSync(current, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const next = path.join(current, entry.name)
    if (isHarmonyProject(next)) {
      return next;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'oh_modules') {
      continue
    }
    const found = searchHarmonyProject(path.join(current, entry.name), depth + 1, maxDepth)
    if (found) {
      return found;
    }
  }
  return undefined;
}

function isHarmonyProject(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "build-profile.json5")) &&
    (fs.existsSync(path.join(dir, "hvigorfile.js")) || fs.existsSync(path.join(dir, "hvigorfile.ts")))
  );
}

function sanitizeFilePath(filePath: string, worktree: string): string {
  const resolved = path.resolve(worktree, filePath)
  const realResolved = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved
  const realWorktree = fs.existsSync(worktree) ? fs.realpathSync(worktree) : worktree
  const normalizedResolved = path.normalize(realResolved)
  const normalizedWorktree = path.normalize(realWorktree)
  const prefix = normalizedWorktree.endsWith(path.sep) ? normalizedWorktree : normalizedWorktree + path.sep
  if (normalizedResolved !== normalizedWorktree && !normalizedResolved.startsWith(prefix)) {
    throw new Error(`Path traversal detected: ${filePath} resolves to ${resolved}, which is outside worktree ${worktree}`)
  }
  return realResolved;
}
