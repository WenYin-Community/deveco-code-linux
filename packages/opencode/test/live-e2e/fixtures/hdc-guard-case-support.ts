// Shared plumbing for the HDC guard live E2E cases: one isolated
// workspace + cache, the guarded shell env, the debug-agent bash
// probe, and the device-side checks. Keeping it here means each case
// file only holds its own probes and assertions.

import fs from "node:fs/promises"
import stripAnsi from "strip-ansi"
import { buildEnv, findDevEcoHome, hdcPath, sdkPath } from "../../../src/tool/lib/env"
import { realUserEnv, runProcess } from "../env"
import type { CaseContext, CaseRunResult, RunCommandResult } from "../types"

export interface GuardCaseFixture {
  home: string
  hdc: string
  env: Record<string, string | undefined>
  workspace: string
  cacheDir: string
}

// Creates the temp workspace plus isolated cache (so the hdc shim and
// run artifacts never pollute the user's real bin dir), then always
// removes both. Device-side cleanup stays with the case body.
export async function withGuardWorkspace(
  ctx: CaseContext,
  prefix: string,
  body: (fixture: GuardCaseFixture) => Promise<CaseRunResult>,
): Promise<CaseRunResult> {
  const home = await findDevEcoHome()
  if (!home) throw new Error("DevEco Studio was not found")

  const workspace = await ctx.createTempWorkspace(prefix)
  const cacheDir = await ctx.createTempWorkspace("hdc-guard-cache-")
  const env = { ...realUserEnv(), ...buildEnv(home, sdkPath(home)), XDG_CACHE_HOME: cacheDir }
  try {
    return await body({ home, hdc: hdcPath(home), env, workspace, cacheDir })
  } finally {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface GuardBashOutput {
  exit: number
  output: string
  stdout: string
}

// Runs one command through the debug agent's bash tool inside the
// guarded shell (the shell.env hook arms the guard for it).
export async function runGuardedBash(
  ctx: CaseContext,
  env: Record<string, string | undefined>,
  command: string,
  description: string,
): Promise<GuardBashOutput> {
  const result = await ctx.runDeveco(
    ["debug", "agent", "build", "--tool", "bash", "--params", JSON.stringify({ command, description })],
    { env, timeoutMs: 60_000 },
  )
  return { ...requireBashOutput(result, command), stdout: result.stdout }
}

export async function removeDeviceFiles(hdc: string, paths: string[]): Promise<void> {
  await runProcess([hdc, "shell", "rm", "-f", ...paths], 15_000)
}

// hdc shell does not forward remote exit codes; absence is detected
// from the shell's error message instead.
export async function deviceFileMissing(hdc: string, remotePath: string): Promise<boolean> {
  const cat = await runProcess([hdc, "shell", "cat", remotePath], 15_000)
  return cat.stdout.includes("No such file or directory") || cat.stderr.includes("No such file or directory")
}

interface DebugToolResult {
  tool?: unknown
  input?: unknown
  result?: { metadata?: { exit?: unknown }; output?: unknown }
}

function parseDebugToolResult(stdout: string): DebugToolResult {
  const clean = stripAnsi(stdout)
  const start = clean.indexOf("{")
  const end = clean.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`debug tool stdout did not contain JSON: ${stdout}`)
  }
  return JSON.parse(clean.slice(start, end + 1)) as DebugToolResult
}

function requireBashOutput(result: RunCommandResult, command: string): { exit: number; output: string } {
  const parsed = parseDebugToolResult(result.stdout)
  if (parsed.tool !== "bash") throw new Error(`Expected debug tool result for bash, got ${String(parsed.tool)}`)
  const input = parsed.input as { command?: unknown } | undefined
  if (input?.command !== command) {
    throw new Error(`Unexpected bash command: ${String(input?.command)}`)
  }
  const metadata = parsed.result?.metadata as { exit?: unknown } | undefined
  const output = typeof parsed.result?.output === "string" ? parsed.result.output : ""
  return { exit: typeof metadata?.exit === "number" ? metadata.exit : -1, output }
}
