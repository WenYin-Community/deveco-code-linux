import { Effect, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import { rm, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import type { Node } from "web-tree-sitter"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { sanitizePath } from "@opencode-ai/core/sanitize-path"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell, PS_ENCODING_PREAMBLE } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"
import { Sandbox, toNativePrepareRequest, fromNativePreparedCommand, resolveSandboxAndMapError } from "@opencode-ai/core/sandbox"
import { SandboxResolver } from "@opencode-ai/core/config/sandbox-resolver"
import { ConfigSandbox, type ResolvedProfile } from "@opencode-ai/core/config/sandbox"
import { getRuntimeSandbox } from "@opencode-ai/core/config/runtime-sandbox"
import { addSandboxPid, removeSandboxPid } from "@opencode-ai/core/config/sandbox-pids"
import { SandboxRuntime as NativeSandboxRuntime } from "@bitfun-ai/sandbox"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { getSessionCwd, setSessionCwd } from "./lib/session-cwd"
import { resolveCliInvocation } from "@/deveco-cli/commands"
import { DEVECO_CLI_EVENT_FILE, type DevecoCliEvent } from "@/deveco-cli/event"
import { ASK_DOCS_PREVIEW_CHARS, DOCS_PREVIEW_CHARS_ENV } from "@/deveco-cli/router"
import { HdcHostEnforcement } from "@/hdc/host-enforcement"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "@/agent/agent"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
export const DEVECO_IMAGE_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000
const DEVECO_IMAGE_DOWNLOAD_COMMAND = new RegExp(
  "\\bdevecocli(?:\\.(?:cmd|exe))?\\s+emulator\\s+image\\s+download\\b",
  "i",
)
const SHELL_COMMAND_QUOTES = new RegExp("[\"']", "g")
const SHELL_COMMAND_WHITESPACE = new RegExp("\\s+", "g")

export function resolveShellTimeout(command: string, timeout: number): number {
  const normalized = command.replace(SHELL_COMMAND_QUOTES, " ").replace(SHELL_COMMAND_WHITESPACE, " ")
  return DEVECO_IMAGE_DOWNLOAD_COMMAND.test(normalized) ? Math.max(timeout, DEVECO_IMAGE_DOWNLOAD_TIMEOUT_MS) : timeout
}

const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

type ShellRunInput = {
  shell: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  description: string
  devecoCliEventFile: string
}

type ShellRunLimits = {
  maxBytes: number
  maxLines: number
}

type ShellRunState = {
  full: string
  last: string
  list: Chunk[]
  used: number
  file: string
  sink?: ReturnType<typeof createWriteStream>
  cut: boolean
  expired: boolean
  aborted: boolean
  sandboxError?: string
  requestId?: string
  sandboxStartTime?: number
  hostEnforcement?: string
  // Effective profile info, for sandbox-denial hint in shell_metadata
  sandboxProfileId?: string
  sandboxNetworkEnabled?: boolean
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

async function readDevecoCliEvents(file: string): Promise<DevecoCliEvent[]> {
  const text = await Bun.file(file)
    .text()
    .catch(() => "")
  await rm(file, { force: true }).catch(() => undefined)
  return text.split(/\r?\n/).filter(Boolean).flatMap(parseDevecoCliEvent)
}

function parseDevecoCliEvent(line: string): DevecoCliEvent[] {
  try {
    const event: unknown = JSON.parse(line)
    if (!event || typeof event !== "object") return []
    const value = event as Record<string, unknown>
    if (typeof value.command !== "string" || !value.command) return []
    if (value.subcommand !== undefined && typeof value.subcommand !== "string") return []
    if (typeof value.exitCode !== "number" || typeof value.durationMs !== "number") return []
    // The event file is writable by every command the shell tool runs, so the payload is not
    // trusted: re-apply the counting policy (unknown commands are dropped, a subcommand the
    // command does not own is normalised away) instead of accepting whatever shape is on disk.
    // resolveCliInvocation is the single source of truth for that policy (deveco-cli/commands.ts).
    const subcommand = typeof value.subcommand === "string" && value.subcommand ? value.subcommand : undefined
    const invocation = resolveCliInvocation([value.command, ...(subcommand ? [subcommand] : [])])
    if (!invocation) return []
    return [
      {
        command: invocation.command,
        ...(invocation.subcommand ? { subcommand: invocation.subcommand } : {}),
        exitCode: value.exitCode,
        durationMs: value.durationMs,
        ...(typeof value.projectRoot === "string" ? { projectRoot: value.projectRoot } : {}),
      },
    ]
  } catch {
    return []
  }
}

function updateSessionCwdFromDevecoCliEvents(events: DevecoCliEvent[], cwd: string, sessionID: string) {
  const projectDir = events.findLast(
    (event) => event.command === "create" && event.exitCode === 0 && event.projectRoot,
  )?.projectRoot
  if (!projectDir) return ""
  const projectRoot = path.resolve(cwd, projectDir)
  setSessionCwd(sessionID, projectRoot)
  return `\n\n[Session directory auto-switched to ${projectRoot}]`
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (
  ctx: Tool.Context,
  scan: Scan,
  input: { command: string; description: string },
) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        description: input.description,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
      description: input.description,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(
      shell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_ENCODING_PREAMBLE + command],
      {
        cwd,
        env,
        stdin: "ignore",
        detached: false,
      },
    )
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser, Language } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const agents = yield* Agent.Service
    // Sandbox: default profile (read-only), prepared via native runtime.
    // core's Config.Service (@opencode/v2/Config) isn't available in the
    // opencode bundle (bun bundler creates a separate context tag identity
    // that doesn't match across package boundaries), so we resolve directly
    // to the default profile and call the native runtime ourselves.
    const nativeRuntime = lazy(() =>
      NativeSandboxRuntime.new({ state_dir: null, bundled_executables_dir: null }),
    )
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved: resolved ? sanitizePath(resolved) : resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string, directory: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID, directory },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const closeSink = Effect.fnUntraced(function* (state: ShellRunState) {
      const stream = state.sink
      if (!stream) return
      state.sink = undefined
      if (stream.destroyed || stream.closed) return
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            let settled = false
            const done = () => {
              if (settled) return
              settled = true
              stream.off("close", done)
              stream.off("error", done)
              stream.off("finish", done)
              resolve()
            }
            stream.once("close", done)
            stream.once("error", done)
            stream.once("finish", done)
            stream.end(done)
          }),
      ).pipe(Effect.catch(() => Effect.void))
    })

    const captureChunk = (chunk: string, input: ShellRunInput, state: ShellRunState, limits: ShellRunLimits) => {
      const size = Buffer.byteLength(chunk, "utf-8")
      state.list.push({ text: chunk, size })
      state.used += size
      while (state.used > limits.maxBytes * 2 && state.list.length > 1) {
        const item = state.list.shift()
        if (!item) break
        state.used -= item.size
        state.cut = true
      }
      state.last = preview(state.last + chunk)
      if (state.file) state.sink?.write(chunk)
      if (!state.file) state.full += chunk
      if (!state.file && Buffer.byteLength(state.full, "utf-8") > limits.maxBytes) {
        return trunc.write(state.full).pipe(
          Effect.andThen((file) =>
            Effect.sync(() => {
              state.file = file
              state.cut = true
              state.sink = createWriteStream(file, { flags: "a" })
              state.full = ""
            }),
          ),
          Effect.andThen(ctxMetadata(input, state.last)),
        )
      }
      return ctxMetadata(input, state.last)
    }

    const ctxMetadata = (input: ShellRunInput, output: string) =>
      Effect.succeed({
        metadata: {
          output,
          description: input.description,
        },
      })

    // ─── Sandbox config loading (FR-CFG-001/010/011) ──────────
    // Reads deveco.json(c) from global and project layers, builds
    // LayeredSandboxConfig, then calls SandboxResolver.resolveSandbox()
    // to validate + resolve the effective profile.
    // This bypasses core's Config.Service (@opencode/v2/Config) which
    // isn't available in the opencode bundle context.

    // S23: filename order aligned with opencode Config service
    const configFilenames = ["deveco.jsonc", "deveco.json", "config.json"]

    function extractSandbox(jsonText: string): ConfigSandbox.SandboxConfig | undefined {
      const errors: ParseError[] = []
      const parsed = parseJsonc(jsonText, errors, { allowTrailingComma: true })
      // S11: log parse errors so malformed config isn't silently dropped.
      // console.warn is acceptable here: this runs at config-load time (not
      // per-command), so it won't pollute the TUI input window repeatedly.
      if (errors.length) {
        console.warn(`[sandbox] JSONC parse errors in config: ${JSON.stringify(errors)}`)
        return undefined
      }
      const sandbox = (parsed as Record<string, unknown>)?.sandbox
      if (!sandbox || typeof sandbox !== "object") return undefined
      // S-MERGE-5: strict shape validation — reject type mismatches before casting
      return ConfigSandbox.validateSandboxShape(sandbox)
    }

    async function readSandboxConfig(filepath: string): Promise<ConfigSandbox.SandboxConfig | undefined> {
      let text: string | undefined
      try {
        text = await readFile(filepath, "utf-8")
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
        console.warn(`[sandbox] Failed to read config file ${filepath}:`, err instanceof Error ? err.message : String(err))
        return undefined
      }
      if (!text) return undefined
      return extractSandbox(text)
    }

    // S-AGENT-1: per-agent sandbox override "视同声明它的配置层的选择"，
    // 优先级高于同层顶层 sandbox.profile。所以 agent override 的所有字段
    // 覆盖 base（profile/network/allowed_profiles），profiles 深度合并。
    // agent override 仍然是 project 层的一部分，runtime 层可以覆盖它。
    function mergeSandboxConfig(
      base: ConfigSandbox.SandboxConfig,
      override: ConfigSandbox.SandboxConfig,
    ): ConfigSandbox.SandboxConfig {
      return {
        ...base,
        ...override,
        profiles: { ...(base.profiles ?? {}), ...(override.profiles ?? {}) },
      }
    }

    function findProjectConfig(startDir: string): string | undefined {
      let dir = startDir
      while (dir !== path.dirname(dir)) {
        const found = findConfigInDir(dir) ?? findConfigInDir(path.join(dir, ".deveco"))
        if (found) return found
        dir = path.dirname(dir)
      }
      return undefined
    }

    function findConfigInDir(dir: string): string | undefined {
      for (const name of configFilenames) {
        const candidate = path.join(dir, name)
        if (existsSync(candidate)) return candidate
      }
      return undefined
    }

    function findGlobalConfig(): string | undefined {
      for (const name of configFilenames) {
        const candidate = path.join(Global.Path.config, name)
        if (existsSync(candidate)) return candidate
      }
      return undefined
    }

    // FR-CFG-009: resolve runtime layer from env vars when no session override exists.
    // Checks DEVECO_CONFIG_CONTENT (inline JSON) then DEVECO_CONFIG (file path).
    const resolveRuntimeEnvLayer = Effect.fn("ShellTool.resolveRuntimeEnvLayer")(
      function* () {
        const envContent = process.env.DEVECO_CONFIG_CONTENT
        if (envContent) {
          const parsed = extractSandbox(envContent)
          if (parsed) return parsed
        }
        const envConfigPath = process.env.DEVECO_CONFIG
        if (envConfigPath) {
          return yield* Effect.promise(() => readSandboxConfig(envConfigPath))
        }
        return undefined
      },
    )

    const resolveSandboxProfile = Effect.fn("ShellTool.resolveSandboxProfile")(function* (cwd: string, agentSandbox?: ConfigSandbox.SandboxConfig) {
      const layers: SandboxResolver.LayeredSandboxConfig = {}

      const globalPath = findGlobalConfig()
      if (globalPath) {
        const globalSandbox = yield* Effect.promise(() => readSandboxConfig(globalPath))
        if (globalSandbox) layers.global = globalSandbox
      }

      const projectPath = findProjectConfig(cwd)
      if (projectPath && path.dirname(projectPath) !== Global.Path.config) {
        const projectSandbox = yield* Effect.promise(() => readSandboxConfig(projectPath))
        if (projectSandbox) layers.project = projectSandbox
      }

      // FR-CFG-008 (S-AGENT-1): per-agent sandbox override is NOT the runtime layer.
      // It "视同声明它的配置层的选择" — merged into the project layer so it
      // overrides the project-level top-level selection but is still subject to
      // the runtime layer (session switch, S-SESS-1) and higher-priority overrides.
      if (agentSandbox) {
        layers.project = layers.project
          ? mergeSandboxConfig(layers.project, agentSandbox)
          : agentSandbox
      }

      // FR-CFG-009 (S-SESS-1): runtime injection layer — highest priority.
      // Sources (checked in order): process-level session override > DEVECO_CONFIG_CONTENT > DEVECO_CONFIG
      const sessionOverride = yield* Effect.promise(() => getRuntimeSandbox())
      if (sessionOverride) {
        layers.runtime = sessionOverride
      } else {
        layers.runtime = yield* resolveRuntimeEnvLayer()
      }

      return yield* resolveSandboxAndMapError(layers)
    })

    // FR-EXEC-003: handle.kill() terminates the sandbox-exec process.
    // sandbox-exec exec's into zsh which exec's into the target command,
    // so handle.pid is the final process PID and handle.kill() is sufficient.
    const executeShell = Effect.fn("ShellTool.executeShell")(function* (
      input: ShellRunInput,
      ctx: Tool.Context,
      state: ShellRunState,
      limits: ShellRunLimits,
    ) {
      yield* Effect.addFinalizer(() => closeSink(state))

      // Sandbox: resolve effective profile from config files, then prepare
      // command via native runtime (FR-CFG-010/011, FR-OBS-001/002, FR-FAIL-001).
      // On macOS: prepare() generates a Seatbelt policy wrapped in sandbox-exec.
      // full-access skips prepare() and spawns directly — sandbox-exec with
      // Unrestricted filesystem still blocks macOS system services (§8.22).
      // On non-macOS: sandbox is macOS-only, commands execute without sandbox.
      const requestId = `sbx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const commandTag = input.command.trim().split(/\s+/)[0] || "unknown"
      const sandboxStartTime = Date.now()
      const isMac = process.platform === "darwin"
      state.requestId = requestId
      state.sandboxStartTime = sandboxStartTime

      // FR-OBS-001: Record started event before any sandbox work so config
      // failures still produce a start event. Only one start event per request.
      yield* Effect.logInfo(
        `sandbox_request_started request_id=${requestId} capability=${isMac ? "macos-seatbelt" : "none"} platform=${process.platform} profile_type=pending network_state=pending command_tag=${commandTag}`,
      )

      // FR-CFG-010/011: Load and validate sandbox config before executing any command.
      // Config errors (config_invalid) cause the command to be rejected — fail closed.
      // Sandbox is macOS-only. Non-macOS falls through to direct execution.
      let profile: ResolvedProfile | undefined
      if (isMac) {
        // FR-CFG-008 (S-AGENT-1): per-agent sandbox override, merged into project layer
        let agentSandbox: ConfigSandbox.SandboxConfig | undefined
        if (ctx.agent) {
          const agentInfo = yield* agents.get(ctx.agent).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (agentInfo?.sandbox) agentSandbox = agentInfo.sandbox
        }
        // FR-OBS-002: Catch config/constraint failures to record finished event before re-failing.
        const resolvedProfile = yield* resolveSandboxProfile(input.cwd, agentSandbox).pipe(
          Effect.catchTags({
            SandboxError: (err) =>
              Effect.gen(function* () {
                yield* Effect.logInfo(
                  `sandbox_request_finished request_id=${requestId} enforcement_result=failed execution_result=failed duration_ms=${Date.now() - sandboxStartTime} failure_stage=${err.phase} error_type=${err.code} error_message=${err.message}`,
                )
                return yield* Effect.fail(err)
              }),
          }),
        )
        // Native prepare requires at least one workspace root (the cwd).
        // full-access bypasses sandbox-exec entirely.
        profile = resolvedProfile.profile_id === "full-access"
          ? resolvedProfile
          : resolvedProfile.workspace_roots.length === 0
            ? { ...resolvedProfile, workspace_roots: [input.cwd] }
            : resolvedProfile
        // Save effective profile info to state for sandbox-denial hint in shell_metadata.
        state.sandboxProfileId = profile.profile_id
        state.sandboxNetworkEnabled = profile.network_enabled
      }

      // FR-HOST-101 / AR-HDC-SEC1-007: macOS host anti-bypass. Discover the
      // real hdc binaries and inject direct-exec/direct-read deny plus the
      // minimal guard UDS allowance into the profile, then run the four
      // canaries before any protected command starts. Any canary failure
      // fails closed — the command must not start (no degraded run).
      if (isMac && profile && profile.profile_id !== "full-access") {
        const protectedBins = yield* Effect.promise(() => HdcHostEnforcement.protectedHdcBinaries()).pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
        )
        if (protectedBins.length > 0) {
          const injectedProfile = HdcHostEnforcement.injectHostEnforcement(profile, protectedBins, input.env.DEVECO_CODE_HDC_ENDPOINT)
          profile = injectedProfile
          const canaries = yield* Effect.tryPromise({
            try: () =>
              HdcHostEnforcement.runHostEnforcementCanaries(
                {
                  profile: injectedProfile,
                  bins: protectedBins,
                  env: input.env as Record<string, string>,
                  cwd: input.cwd,
                  armed: Boolean(
                    input.env.DEVECO_CODE_HDC_ENDPOINT &&
                      input.env.DEVECO_CODE_HDC_TOKEN &&
                      input.env.DEVECO_CODE_HDC_SESSION,
                  ),
                },
                {
                  prepare: (request) => nativeRuntime().prepare(request),
                },
              ),
            catch: (err) =>
              new Sandbox.SandboxError({
                code: "ProbeFailed",
                phase: "Probe",
                message: err instanceof Error ? err.message : String(err),
              }),
          }).pipe(
            Effect.catchTags({
              SandboxError: (err) =>
                Effect.gen(function* () {
                  state.hostEnforcement = "failed"
                  yield* Effect.logInfo(
                    `sandbox_request_finished request_id=${requestId} enforcement_result=failed execution_result=failed host_enforcement=failed duration_ms=${Date.now() - sandboxStartTime} failure_stage=${err.phase} error_type=${err.code} error_message=${err.message}`,
                  )
                  return yield* Effect.fail(err)
                }),
            }),
          )
          state.hostEnforcement = "applied"
          const summary = canaries.cached
            ? "cached"
            : canaries.results.map((result) => `${result.name}:${result.status}`).join(",")
          yield* Effect.logInfo(
            `hdc_host_enforcement bins=${protectedBins.length} host_enforcement=applied canaries=${summary}`,
          )
        }
      } else if (isMac && profile && profile.profile_id === "full-access") {
        state.hostEnforcement = "bypassed"
      }

      let spawnCmd = cmd(input.shell, input.command, input.cwd, input.env)

      let prepareDurationMs: number | undefined
      let failureStage: string | undefined
      let errorType: string | undefined

      // full-access: direct execution without sandbox-exec. read-only/workspace
      // go through native prepare() to generate Seatbelt policy.
      if (isMac && profile && profile.profile_id !== "full-access") {
        const prepareRequest = toNativePrepareRequest(profile, {
          executable: input.shell,
          args: ["-c", input.command],
          cwd: input.cwd,
          env: Object.fromEntries(
            Object.entries(input.env).filter(([, v]) => v !== undefined),
          ) as Record<string, string>,
        })

        const prepareStartTime = Date.now()
        const prepared = yield* Effect.tryPromise({
          try: () => nativeRuntime().prepare(prepareRequest),
          catch: (err) => new Sandbox.SandboxError({
            code: "PrepareFailed",
            phase: "Prepare",
            message: err instanceof Error ? err.message : "Sandbox prepare failed",
          }),
        }).pipe(
          Effect.catchTags({
            SandboxError: (err) =>
              Effect.gen(function* () {
                prepareDurationMs = Date.now() - prepareStartTime
                failureStage = err.phase
                errorType = err.code
                yield* Effect.logInfo(
                  `sandbox_request_finished request_id=${requestId} enforcement_result=failed host_enforcement=${state.hostEnforcement ?? "not_applicable"} execution_result=failed duration_ms=${Date.now() - sandboxStartTime} prepare_duration_ms=${prepareDurationMs} failure_stage=${failureStage} error_type=${errorType} error_message=${err.message}`,
                )
                return yield* Effect.fail(err)
              }),
          }),
        )
        prepareDurationMs = Date.now() - prepareStartTime
        const converted = fromNativePreparedCommand(prepared)
        spawnCmd = ChildProcess.make(converted.executable, converted.args, {
          cwd: converted.cwd,
          env: converted.env,
          stdin: "ignore",
          // FR-EXEC-006: detached=false keeps child in parent's process group,
          // so OS-level signals (SIGHUP/SIGTERM) propagate to children when
          // the host is terminated. forceKillAfter handles graceful cancel.
          detached: false,
        })
      }

      const handle = yield* spawner.spawn(spawnCmd)
      // FR-EXEC-006: Persist sandbox-exec PID so a crashed host can clean up
      // orphaned processes on next bootstrap. Removed after graceful exit below.
      if (isMac && handle.pid) {
        yield* Effect.promise(() => addSandboxPid(handle.pid!))
      }
      yield* Effect.forkScoped(
        Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
          captureChunk(chunk, input, state, limits).pipe(Effect.andThen((metadata) => ctx.metadata(metadata))),
        ),
      )
      const abort = Effect.callback<void>((resume) => {
        if (ctx.abort.aborted) return resume(Effect.void)
        const handler = () => resume(Effect.void)
        ctx.abort.addEventListener("abort", handler, { once: true })
        return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
      })
      const exit = yield* Effect.raceAll([
        handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
        abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
        Effect.sleep(`${input.timeout + 100} millis`).pipe(
          Effect.map(() => ({ kind: "timeout" as const, code: null })),
        ),
      ])

      const enforcementResult = isMac ? (profile?.profile_id === "full-access" ? "bypassed" : "applied") : "bypassed"
      const executionResult = exit.kind === "exit" ? (exit.code === 0 ? "success" : "failed") : exit.kind === "timeout" ? "timeout" : "cancelled"
      const cleanupResult = exit.kind === "exit" ? "none" : "killed"
      const finishedParts = [
        `request_id=${requestId}`,
        `enforcement_result=${enforcementResult}`,
        `host_enforcement=${state.hostEnforcement ?? (isMac ? "not_applicable" : "not_applicable")}`,
        `execution_result=${executionResult}`,
        `duration_ms=${Date.now() - sandboxStartTime}`,
        `cleanup_result=${cleanupResult}`,
      ]
      if (prepareDurationMs !== undefined) finishedParts.push(`prepare_duration_ms=${prepareDurationMs}`)
      if (failureStage) finishedParts.push(`failure_stage=${failureStage}`)
      if (errorType) finishedParts.push(`error_type=${errorType}`)
      yield* Effect.logInfo(
        `sandbox_request_finished ${finishedParts.join(" ")}`,
      )

      if (exit.kind === "exit") {
        if (isMac && handle.pid) {
          yield* Effect.promise(() => removeSandboxPid(handle.pid!)).pipe(Effect.ignore)
        }
        return exit.code
      }
      state.aborted = exit.kind === "abort"
      state.expired = exit.kind === "timeout"
      // FR-EXEC-003: handle.kill() terminates the target process.
      // sandbox-exec exec's into the target command, so handle.pid is the
      // final process PID and handle.kill() is sufficient to end it.
      yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
      if (isMac && handle.pid) {
        yield* Effect.promise(() => removeSandboxPid(handle.pid!)).pipe(Effect.ignore)
      }
      return null
    })

    // Heuristic detection of sandbox policy denials based on stderr content
    // and the effective profile. Used to append a explanatory hint to
    // shell_metadata so users/agents understand the failure was likely
    // caused by the sandbox (not by the command itself or host permissions).
    //
    // Not 100% precise: "permission denied" can also come from the regular
    // filesystem. We only claim "likely" in the hint text.
    function detectSandboxDenial(stderr: string, profileId?: string, networkEnabled?: boolean): "file" | "network" | null {
      if (!profileId || profileId === "full-access") return null
      // Seatbelt write/exit denials appear as "operation not permitted".
      if (/operation not permitted/i.test(stderr)) return "file"
      // Network blocked by sandbox profile.
      if (!networkEnabled && /connection refused|network unreachable|could not resolve host|network is down/i.test(stderr)) return "network"
      // read-only profile rejects every write, so permission denied on writes
      // is almost certainly the sandbox.
      if (profileId === "read-only" && /permission denied/i.test(stderr)) return "file"
      return null
    }

    function sandboxHintMessage(denial: "file" | "network", profileId: string, networkEnabled: boolean): string {
      const base = `[SANDBOX] profile=${profileId}, network=${networkEnabled ? "on" : "off"} — 此操作可能被沙箱策略阻止。`
      if (denial === "network") {
        return `${base}当前沙箱网络已关闭，请使用 webfetch 工具访问网络，或切换到 workspace/full-access profile。`
      }
      return `${base}请使用 write 工具进行文件操作，或切换到 workspace/full-access profile。`
    }

    const finishShell = Effect.fn("ShellTool.finishShell")(function* (
      input: ShellRunInput,
      ctx: Tool.Context,
      state: ShellRunState,
      limits: ShellRunLimits,
      code: number | null,
    ) {
      const events = yield* Effect.promise(() => readDevecoCliEvents(input.devecoCliEventFile))
      const raw = state.list.map((item) => item.text).join("")
      // Compute sandbox denial hint once; reused in both meta (LLM) and UI output.
      const denial = (code !== null && code !== 0 && state.sandboxProfileId)
        ? detectSandboxDenial(raw, state.sandboxProfileId, state.sandboxNetworkEnabled)
        : null
      const sandboxHint = denial
        ? sandboxHintMessage(denial, state.sandboxProfileId!, state.sandboxNetworkEnabled ?? false)
        : ""
      const meta = [
        ...(state.expired
          ? [
              `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
            ]
          : []),
        ...(state.sandboxError
          ? [`Sandbox blocked the command: ${state.sandboxError}`]
          : state.aborted ? ["User aborted the command"] : []),
        // Sandbox denial hint: when the command exited non-zero and stderr
        // matches sandbox denial patterns under an applied profile, append an
        // explanation so users/agents can understand the cause.
        ...(sandboxHint ? [sandboxHint] : []),
      ]
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      state.cut ||= end.cut
      if (!state.file && end.cut) state.file = yield* trunc.write(raw)
      const truncated =
        state.cut && state.file ? `...output truncated...\n\nFull output saved to: ${state.file}\n\n` : ""
      const metadata = meta.length > 0 ? `\n\n<shell_metadata>\n${meta.join("\n")}\n</shell_metadata>` : ""
      const output =
        truncated +
        (end.text || "(no output)") +
        metadata +
        updateSessionCwdFromDevecoCliEvents(events, input.cwd, ctx.sessionID)
      // UI display: replace <shell_metadata> block with single-line [SANDBOX] hint
      // so users see a concise, structured prefix per industry logging conventions.
      const metadataOutput = preview(output.includes("<shell_metadata>") && sandboxHint
        ? output.replace(/<shell_metadata>[\s\S]*?<\/shell_metadata>/, sandboxHint)
        : output)
      return {
        title: input.description,
        metadata: {
          output: metadataOutput,
          exit: code,
          description: input.description,
          truncated: state.cut,
          devecoCliEvents: events,
          ...(state.cut && state.file ? { outputPath: state.file } : {}),
        },
        output,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (input: ShellRunInput, ctx: Tool.Context) {
      const limits = yield* trunc.limits()
      const state: ShellRunState = {
        full: "",
        last: "",
        list: [],
        used: 0,
        file: "",
        cut: false,
        expired: false,
        aborted: false,
      }
      yield* ctx.metadata({ metadata: { output: "", description: input.description } })
      const code = yield* Effect.scoped(executeShell(input, ctx, state, limits)).pipe(
        Effect.catchTags({
          SandboxError: (err) =>
            Effect.gen(function* () {
              state.aborted = true
              state.sandboxError = `[${err.code}] ${err.message}`
              yield* ctx.metadata({ metadata: { output: `[sandbox error] [${err.code}] ${err.message}`, description: input.description } })
              return null
            }),
        }),
        Effect.catch((err: unknown) =>
          Effect.gen(function* () {
            state.aborted = true
            // FR-OBS-002: Record finished event for non-SandboxError failures.
            if (state.requestId && state.sandboxStartTime) {
              yield* Effect.logInfo(
                `sandbox_request_finished request_id=${state.requestId} enforcement_result=failed host_enforcement=${state.hostEnforcement ?? "not_applicable"} execution_result=failed duration_ms=${Date.now() - state.sandboxStartTime} error_type=internal_error error_message=${err instanceof Error ? err.message : String(err)}`,
              )
            }
            yield* ctx.metadata({ metadata: { output: `[shell error] ${err instanceof Error ? err.message : String(err)}`, description: input.description } })
            return null
          }),
        ),
      )
      return yield* finishShell(input, ctx, state, limits, code)
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : (getSessionCwd(ctx.sessionID) ?? instanceCtx.directory)
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = resolveShellTimeout(params.command, params.timeout ?? defaultTimeoutMs)
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              const devecoCliEventFile = path.join(
                Global.Path.tmp,
                "devecocli-events",
                `${process.pid}-${randomUUID()}.jsonl`,
              )
              const env: NodeJS.ProcessEnv = {
                ...(yield* shellEnv(ctx, cwd, instanceCtx.directory)),
                [DEVECO_CLI_EVENT_FILE]: devecoCliEventFile,
              }
              // ask gets a larger single-pass docs preview; every other agent has the variable
              // removed so an ambient override never widens its preview.
              if (ctx.agent === "ask") env[DOCS_PREVIEW_CHARS_ENV] = String(ASK_DOCS_PREVIEW_CHARS)
              else delete env[DOCS_PREVIEW_CHARS_ENV]
              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env,
                  timeout,
                  description: params.description,
                  devecoCliEventFile,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
