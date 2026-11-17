export * as HdcShimEnv from "./shim-env"

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { isolatedShellPath } from "@/util/shim"
import { resolveHdcShimLauncher } from "./launcher"
import { HdcIpcServer } from "./ipc-server"
import { handleGuardRequest, registerSession } from "./service"

// ─── HDC guard shell environment (SR1) ──────────────────────
// Wires the guard into every controlled shell:
//  1. writes the hdc shim (hdc.cmd on Windows) into the deveco bin
//     cache directory that only controlled shells put on PATH —
//     never the user's global PATH;
//  2. starts the per-process guard IPC server (lazy singleton);
//  3. injects the guard environment variables plus a PATH that
//     resolves hdc to the shim.
//
// If any step fails, no env is injected and the shell still
// works — hdc then fails closed at the shim (CON-05).

function unixArg(input: string) {
  return "'" + input.replaceAll("'", "'\"'\"'") + "'"
}

function windowsArg(input: string) {
  return `"${input.replaceAll('"', '""')}"`
}

function unixShimContents(launcher: readonly string[]) {
  return `#!/usr/bin/env sh\nexec ${launcher.map(unixArg).join(" ")} __hdc-shim -- "$@"\n`
}

function windowsShimContents(launcher: readonly string[]) {
  return `@ECHO OFF\r\nSETLOCAL\r\n${launcher.map(windowsArg).join(" ")} __hdc-shim -- %*\r\nENDLOCAL & exit /b %ERRORLEVEL%\r\n`
}

async function ensureHdcShim(binDir = Global.Path.bin): Promise<void> {
  const launcher = resolveHdcShimLauncher()
  await mkdir(binDir, { recursive: true })

  const shimPath = path.join(binDir, process.platform === "win32" ? "hdc.cmd" : "hdc")
  const expected = process.platform === "win32" ? windowsShimContents(launcher) : unixShimContents(launcher)
  try {
    if ((await readFile(shimPath, "utf8")) === expected) return
  } catch {
    // Missing shim falls through to the write below.
  }
  await writeFile(shimPath, expected, "utf8")
  if (process.platform !== "win32") await chmod(shimPath, 0o755)
}

let guardReady: Promise<HdcIpcServer.HdcIpcServer> | undefined

function ensureGuardServer(): Promise<HdcIpcServer.HdcIpcServer> {
  guardReady ??= (async () => {
    await ensureHdcShim()
    return HdcIpcServer.startHdcIpcServer(handleGuardRequest)
  })()
  // A failed startup (e.g. pipe collision) must be retryable.
  return guardReady.catch((error) => {
    guardReady = undefined
    throw error
  })
}

export interface HdcGuardShellEnv {
  PATH: string
  DEVECO_CODE_HDC_ENDPOINT: string
  DEVECO_CODE_HDC_TOKEN: string
  DEVECO_CODE_HDC_SESSION: string
  DEVECO_CODE_HDC_CALL?: string
}

export interface HdcGuardShellEnvInput {
  sessionID: string | undefined
  callID: string | undefined
  currentPath: string | undefined
  directory: string | undefined
}

// Returns the env vars that route hdc through the guard for
// one shell, or undefined when the guard cannot arm itself (the
// caller then injects nothing and hdc fails closed at the shim).
// `directory` is the session's instance directory — the key the
// TUI's permission reply resolves the pending ask by, so it must
// be captured at arm time (the shell cwd may drift from it).
export async function ensureHdcGuardShellEnv(input: HdcGuardShellEnvInput): Promise<HdcGuardShellEnv | undefined> {
  // Without a session there is nothing to bind permission asks
  // to; refuse to arm rather than run unattributed (fail closed).
  if (!input.sessionID || !input.directory) return undefined

  const server = await ensureGuardServer()
  registerSession(input.sessionID, input.directory)

  return {
    // Explicit Worker environments use case-sensitive keys, including Windows Path.
    PATH: isolatedShellPath(input.currentPath ?? process.env.PATH ?? process.env.Path, Global.Path.bin),
    DEVECO_CODE_HDC_ENDPOINT: server.endpoint,
    DEVECO_CODE_HDC_TOKEN: server.token,
    DEVECO_CODE_HDC_SESSION: input.sessionID,
    ...(input.callID ? { DEVECO_CODE_HDC_CALL: input.callID } : {}),
  }
}
