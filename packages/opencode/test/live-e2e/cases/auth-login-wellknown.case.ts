import fs from "node:fs/promises"
import path from "node:path"
import stripAnsi from "strip-ansi"
import { realUserEnv } from "../env"
import type { CaseContext, LiveTestCase, RunCommandResult } from "../types"

const CASE_ID = "AUTH_LOGIN_WELLKNOWN"
const TOKEN_VALUE = "live-e2e-wellknown-token"
const REDACTED_TOKEN = "[REDACTED]"

type RequestRecord = { method: string; path: string; authorized?: boolean }

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "通过 Well-known 登录认证服务（含风险确认）",
  category: "cli",
  priority: "P1",
  timeoutMs: 90_000,
  requires: [],
  description:
    "验证 deveco auth login <url> 在发起网络请求前显示三方服务器风险提示并要求确认；拒绝时取消且不发送请求；确认后可通过 well-known 元数据完成登录、凭据持久化和 auth list 回读验证。",
  steps: [
    "创建隔离临时根目录。",
    "启动动态端口的本地 HTTP fixture 服务，提供 well-known 元数据和远程配置。",
    "执行 deveco auth login http://127.0.0.1:<port>，输入 n 拒绝风险确认。",
    "验证输出包含风险提示和 Cancelled、退出码为 0、服务器请求数为 0、凭据文件未创建。",
    "再次执行 deveco auth login http://127.0.0.1:<port>，输入 y 确认风险。",
    "验证登录输出、请求记录和凭据文件。",
    "执行 deveco auth list 验证持久化结果。",
    "移除 fixture token 环境变量后执行 deveco debug config，验证远程配置请求使用持久化 token。",
  ],
  expected: [
    "拒绝确认时输出风险提示和 Cancelled，退出码为 0，无服务器请求，凭据文件未创建。",
    "确认后的登录、list 和 config 退出码均为 0。",
    "well-known 请求至少发生一次。",
    "list 确认存在一个 wellknown 凭据。",
    "远程配置请求携带由持久化 token 生成的正确 Authorization header。",
    "token 未出现在命令输出、报告详情或 artifacts。",
  ],
  code: "packages/opencode/test/live-e2e/cases/auth-login-wellknown.case.ts",
  parallel: false,
  cleanup: "停止本地服务并删除临时根目录；不读取或修改真实用户登录状态或凭据。",
  async run(ctx) {
    const tempRoot = await ctx.createTempWorkspace("auth-login-wellknown-")
    let fixture: ReturnType<typeof startFixtureServer> | undefined
    try {
      fixture = startFixtureServer()
      const providerURL = `http://127.0.0.1:${fixture.port}`
      const env = buildIsolatedEnv(tempRoot)
      const authFile = path.join(tempRoot, "data", "deveco", "auth.json")

      const rejectResult = await verifyRejectedLogin(ctx, providerURL, env, authFile, fixture.requests)

      const loginResult = await runLogin(ctx, providerURL, env)
      await validateAuthFileCreated(authFile, tempRoot)
      const listResult = await runList(ctx, providerURL, env)
      const configResult = await runConfig(ctx, buildVerificationEnv(env))
      validateRequests(fixture.requests)
      return {
        details: {
          providerURL,
          rejectExitCode: rejectResult.exitCode,
          loginExitCode: loginResult.exitCode,
          listExitCode: listResult.exitCode,
          configExitCode: configResult.exitCode,
          rejectDurationMs: rejectResult.durationMs,
          loginDurationMs: loginResult.durationMs,
          listDurationMs: listResult.durationMs,
          configDurationMs: configResult.durationMs,
          authFile,
          serverRequestsAfterReject: 0,
          wellKnownRequestCount: fixture.requests.filter((request) => request.path === "/.well-known/opencode").length,
          remoteConfigRequestCount: fixture.requests.filter((request) => request.path === "/config").length,
          credentialCount: listResult.credentialCount,
        },
      }
    } finally {
      try {
        if (fixture) {
          await ctx
            .writeArtifact(CASE_ID, "requests.json", JSON.stringify(fixture.requests, null, 2))
            .catch(() => undefined)
          await fixture.server.stop(true)
        }
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  },
}

function startFixtureServer() {
  const requests: RequestRecord[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({
        method: request.method,
        path: url.pathname,
        ...(url.pathname === "/config"
          ? { authorized: request.headers.get("authorization") === `Bearer ${TOKEN_VALUE}` }
          : {}),
      })
      if (request.method === "GET" && url.pathname === "/config") {
        return Response.json({ config: { username: "live-e2e-wellknown" } })
      }
      if (request.method !== "GET" || url.pathname !== "/.well-known/opencode") {
        return new Response("Not Found", { status: 404 })
      }
      return Response.json({
        auth: {
          command: [process.execPath, "-e", "process.stdout.write(process.env.LIVE_E2E_AUTH_TOKEN ?? '')"],
          env: "LIVE_E2E_AUTH_TOKEN",
        },
        remote_config: {
          url: `${url.origin}/config`,
          headers: { Authorization: "Bearer {env:LIVE_E2E_AUTH_TOKEN}" },
        },
      })
    },
  })
  return { server, port: server.port, requests }
}

async function verifyRejectedLogin(
  ctx: CaseContext,
  providerURL: string,
  env: Record<string, string | undefined>,
  authFile: string,
  requests: RequestRecord[],
) {
  const result = await runLoginReject(ctx, providerURL, env)
  validateRejectOutput(stripAnsi(result.stdout), providerURL)
  if (requests.length !== 0) throw new Error(`Expected 0 server requests after rejection, got ${requests.length}`)
  const authFileExists = await fs
    .stat(authFile)
    .then(() => true)
    .catch(() => false)
  if (authFileExists) throw new Error(`Auth file should not exist after rejection: ${authFile}`)
  return result
}

async function runLoginReject(ctx: CaseContext, providerURL: string, env: Record<string, string | undefined>) {
  const result = await ctx.runDeveco(["auth", "login", providerURL], { env, stdin: "n\n", timeoutMs: 30_000 })
  await writeSafeArtifacts(ctx, "reject", result)
  requireSuccess("reject", result)
  return result
}

async function runLogin(ctx: CaseContext, providerURL: string, env: Record<string, string | undefined>) {
  const result = await ctx.runDeveco(["auth", "login", providerURL], { env, stdin: "y\n", timeoutMs: 30_000 })
  await writeSafeArtifacts(ctx, "login", result)
  requireSuccess("login", result)
  validateLoginOutput(stripAnsi(result.stdout), providerURL)
  return result
}

async function runList(ctx: CaseContext, providerURL: string, env: Record<string, string | undefined>) {
  const result = await ctx.runDeveco(["auth", "list"], { env, timeoutMs: 15_000 })
  await writeSafeArtifacts(ctx, "list", result)
  requireSuccess("list", result)
  return {
    ...result,
    credentialCount: validateListOutput(stripAnsi(result.stdout), providerURL),
  }
}

async function runConfig(ctx: CaseContext, env: Record<string, string | undefined>) {
  const result = await ctx.runDeveco(["debug", "config"], { env, timeoutMs: 15_000 })
  await writeSafeArtifacts(ctx, "config", result)
  requireSuccess("config", result)
  return result
}

async function writeSafeArtifacts(ctx: CaseContext, label: string, result: RunCommandResult) {
  const exposed = result.stdout.includes(TOKEN_VALUE) || result.stderr.includes(TOKEN_VALUE)
  await Promise.all([
    ctx.writeArtifact(CASE_ID, `${label}-stdout.log`, redact(result.stdout)),
    ctx.writeArtifact(CASE_ID, `${label}-stderr.log`, redact(result.stderr)),
  ])
  if (exposed) throw new Error(`Virtual token was exposed in ${label} command output`)
}

function requireSuccess(label: string, result: RunCommandResult) {
  if (result.exitCode === 0) return
  throw new Error(
    `${label} exited with ${result.exitCode}\nstderr: ${redact(result.stderr)}\nstdout: ${redact(result.stdout)}`,
  )
}

function redact(value: string) {
  return value.replaceAll(TOKEN_VALUE, REDACTED_TOKEN)
}

function buildIsolatedEnv(tempRoot: string) {
  const base: Record<string, string | undefined> = { ...realUserEnv() }
  delete base.DEVECO_AUTH_CONTENT
  delete base.DEVECO_CONFIG
  delete base.DEVECO_CONFIG_CONTENT
  base.NO_PROXY = appendLocalhostToNoProxy(base.NO_PROXY)
  base.no_proxy = appendLocalhostToNoProxy(base.no_proxy)
  return {
    ...base,
    DEVECO_TEST_HOME: tempRoot,
    XDG_DATA_HOME: path.join(tempRoot, "data"),
    XDG_CACHE_HOME: path.join(tempRoot, "cache"),
    XDG_CONFIG_HOME: path.join(tempRoot, "config"),
    XDG_STATE_HOME: path.join(tempRoot, "state"),
    DEVECO_CONFIG_DIR: path.join(tempRoot, "config", "deveco"),
    DEVECO_PURE: "1",
    LIVE_E2E_AUTH_TOKEN: TOKEN_VALUE,
  }
}

function buildVerificationEnv(env: Record<string, string | undefined>) {
  const result = { ...env }
  delete result.LIVE_E2E_AUTH_TOKEN
  return result
}

function appendLocalhostToNoProxy(existing: string | undefined) {
  const suffix = "127.0.0.1,localhost"
  return existing ? `${existing},${suffix}` : suffix
}

function validateLoginOutput(output: string, providerURL: string) {
  const checks = [
    ["Add credential", output.includes("Add credential")],
    ["Server URL", output.includes(`Server: ${providerURL}`)],
    ["third-party", output.includes("third-party")],
    ["Running", output.includes("Running")],
    [`Logged into ${providerURL}`, output.includes(`Logged into ${providerURL}`)],
    ["Done", output.includes("Done")],
  ] as const
  const missing = checks.find((check) => !check[1])
  if (missing) throw new Error(`Expected "${missing[0]}" in login output:\n${redact(output)}`)
}

function validateRejectOutput(output: string, providerURL: string) {
  const checks = [
    ["Add credential", output.includes("Add credential")],
    ["Server URL", output.includes(`Server: ${providerURL}`)],
    ["third-party warning", output.includes("third-party")],
    ["Cancelled", output.includes("Cancelled")],
  ] as const
  const missing = checks.find((check) => !check[1])
  if (missing) throw new Error(`Expected "${missing[0]}" in reject output:\n${redact(output)}`)
  if (output.includes("Running")) throw new Error(`Reject path should not run auth command:\n${redact(output)}`)
  if (output.includes("Logged into")) throw new Error(`Reject path should not log in:\n${redact(output)}`)
}

function validateRequests(requests: RequestRecord[]) {
  const unexpected = requests.filter(
    (request) => request.method !== "GET" || !["/.well-known/opencode", "/config"].includes(request.path),
  )
  if (unexpected.length > 0) {
    throw new Error(`Unexpected fixture requests: ${JSON.stringify(unexpected)}`)
  }
  if (!requests.some((request) => request.path === "/.well-known/opencode")) {
    throw new Error(`Expected at least one GET /.well-known/opencode request, got: ${JSON.stringify(requests)}`)
  }
  const configRequests = requests.filter((request) => request.path === "/config")
  if (configRequests.length === 0) {
    throw new Error(`Expected at least one GET /config request, got: ${JSON.stringify(requests)}`)
  }
  if (configRequests.some((request) => request.authorized !== true)) {
    throw new Error(`Expected every GET /config request to use the persisted token: ${JSON.stringify(requests)}`)
  }
}

async function validateAuthFileCreated(authFile: string, tempRoot: string) {
  const exists = await fs
    .stat(authFile)
    .then(() => true)
    .catch(() => false)
  if (!exists) throw new Error(`Expected auth file to exist: ${authFile}`)
  const relative = path.relative(tempRoot, path.resolve(authFile))
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Auth file path must be inside temp root: ${authFile}`)
  }
  const raw = await fs.readFile(authFile, "utf-8")
  if (raw.includes(TOKEN_VALUE)) {
    throw new Error("Auth file contains plaintext virtual token")
  }
}

function validateListOutput(output: string, providerURL: string) {
  if (!output.includes(providerURL)) throw new Error(`Expected provider URL in list output:\n${output}`)
  if (!output.includes("wellknown")) throw new Error(`Expected "wellknown" in list output:\n${output}`)
  const match = output.match(/\b(\d+)\s+credentials?\b/i)
  if (!match) {
    throw new Error(`Expected credential count in list output:\n${output}`)
  }
  const credentialCount = Number.parseInt(match[1], 10)
  if (credentialCount !== 1) {
    throw new Error(`Expected "1 credentials" in list output:\n${output}`)
  }
  return credentialCount
}

export default testCase
