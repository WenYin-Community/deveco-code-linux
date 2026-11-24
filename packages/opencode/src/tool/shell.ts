import { Effect, Stream } from "effect"
import os from "os"
import { createWriteStream, existsSync, lstatSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
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
import {
  Sandbox,
  toNativePrepareRequest,
  fromNativePreparedCommand,
  resolveSandboxAndMapError,
} from "@opencode-ai/core/sandbox"
import { SandboxResolver } from "@opencode-ai/core/config/sandbox-resolver"
import { ConfigSandbox, type ResolvedProfile } from "@opencode-ai/core/config/sandbox"
import { getRuntimeSandbox } from "@opencode-ai/core/config/runtime-sandbox"
import { addSandboxPid, removeSandboxPid } from "@opencode-ai/core/config/sandbox-pids"
import { SandboxError as NativeSandboxError, SandboxRuntime as NativeSandboxRuntime } from "@bitfun-ai/sandbox"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { getSessionCwd } from "./lib/session-cwd"
import { loadSavedDevEcoHome } from "./lib/env"
import { HdcHostEnforcement } from "@/hdc/host-enforcement"
import { ASK_DOCS_PREVIEW_CHARS, DOCS_PREVIEW_CHARS_ENV, resolveShellTimeout } from "@/agent/shell-policy"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "@/agent/agent"
import { readD2aWorkflowStateFile, projectD2aWorkflowState } from "@/plugin/analytics/d2a"
import type { D2aBuildResult, D2aOperation, D2aObservationBinding, D2aShellSnapshot } from "@/plugin/analytics/d2a"
import { readBundleName } from "@/plugin/analytics/collector"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
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
  // D2A controller observation context (empty calls when nothing was detected).
  d2a: {
    calls: D2aControllerCall[]
    before: Map<string, D2aRunProbe>
    totalCommands: number
    instance: InstanceContext
    // A marked standalone build command (first/final build outcome).
    // Undefined when no valid d2aBuildRunDir was supplied or the command is
    // not a directly attributable single build invocation.
    build?: D2aBuildObservation
  }
}

type D2aBuildObservation = {
  // Validated run snapshot read before the build; the observation is
  // attributed to this run's analytics.runId.
  snapshot: D2aShellSnapshot["snapshot"]
  callId: string
  startedAtMs: number
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

// ─── D2A workflow controller observation ─────────────────────────────────────
// The shell tool recognizes built-in Node Controller invocations of the
// hmos-design-to-arkts skill, reads the run's workflow-state.json before and
// after execution, and attaches a whitelist-projected snapshot to
// metadata.d2aWorkflowSnapshots. Attribution (operation, model) only follows a
// verified state transition with exactly one new revision; everything else is
// a plain reread. Local paths, state原文 and stdout stay local.

const D2A_SCRIPT_REL = path.join("hmos-design-to-arkts", "scripts", "workflow.mjs")
const D2A_OPERATIONS = new Set(["init", "status", "stage-start", "confirm", "stage-complete"])
const D2A_TRACKED_FLAGS = new Set(["mode", "run-dir", "stage", "decision", "result"])

type D2aControllerCall = {
  operation: D2aOperation
  runDir: string
  stage?: number
  decision?: string
  result?: string
}

type D2aRunProbe = {
  exists: boolean
  refused?: boolean
  runId?: string
  revision?: number
  status?: string
  completedStages?: number[]
  startedStages?: Set<number>
}

function d2aPathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value
}

// The built-in install location managed by src/skill/defaults.ts plus the dev
// resources entry; both are recognized so dev and packaged builds observe the
// same commands.
const d2aControllerScriptRealpaths = lazy(async (): Promise<Set<string>> => {
  const candidates = [
    path.join(Global.Path.data, "skills", D2A_SCRIPT_REL),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "resources", "skills", D2A_SCRIPT_REL),
  ]
  const real = new Set<string>()
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      real.add(d2aPathKey(realpathSync(candidate)))
    } catch {
      // not observable from this build
    }
  }
  return real
})

function isD2aInterpreterToken(text: string): boolean {
  const base = path.basename(unquote(text)).toLowerCase()
  return base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe"
}

// parts() deliberately skips bare number arguments (a tree-sitter-bash
// "number" node), but controller flags like `--stage 1` end in one, so the
// D2A walk collects the same shapes plus number tokens. Kept local: including
// numbers in parts() would also change permission-path scanning.
function d2aCommandTokens(node: Node): string[] {
  const out: string[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push(item.text)
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation" &&
      child.type !== "number"
    ) {
      continue
    }
    out.push(child.text)
  }
  return out
}

// ─── D2A PowerShell host-variable expansion ─────────────────────────────────
// A real run binds the skill root and run directory to local variables first and
// then references them in the controller call:
//
//   $skillRoot = "$env:USERPROFILE\.local\share\deveco\skills\hmos-design-to-arkts"
//   $runDir = "D:\Projects\demo\.deveco\design-to-arkts\runs\photo-day-view"
//   node "$skillRoot\scripts\workflow.mjs" --mode init --run-dir "$runDir"
//
// PowerShell expands those before the controller sees them, but the static pass
// cannot resolve local variables, so such calls were dropped and the run was
// only observed on a later call that spelled the paths out. Only the two path
// arguments are expanded, and only from an assignment the parse proves: a
// simple `$name = <string>` in the same top-level statement list, before the
// call. Anything the parse cannot settle — a subexpression, condition, escape,
// unknown or reassigned variable, an unset environment variable — drops that
// call instead of guessing. The command itself, the generic path scan,
// permissions and the sandbox keep running unchanged.

type D2aHostVars = ReadonlyMap<string, string>

// Reads an assignment value as a plain string. A double-quoted value may
// reference `$env:NAME` only, and that variable must exist. A single-quoted
// value is literal, so a `$` inside it would be substituted into a later
// double-quoted token with the wrong single-pass semantics and is refused.
function d2aHostValue(value: Node): string | undefined {
  const text = value.text.trim()
  const literal = [
    ...value.descendantsOfType("string_literal"),
    ...value.descendantsOfType("raw_string_literal"),
  ].find((item) => item?.text === text)
  if (!literal || text.length < 2) return undefined
  const quote = text[0]
  if ((quote !== '"' && quote !== "'") || text[text.length - 1] !== quote) return undefined
  const inner = text.slice(1, -1)
  if (inner.includes("`") || inner.includes("${") || inner.includes("$(")) return undefined
  if (quote === "'") return inner.includes("$") ? undefined : inner
  for (const ref of inner.matchAll(/\$([A-Za-z_][A-Za-z0-9_:]*)/g)) {
    const name = ref[1].toLowerCase()
    if (!name.startsWith("env:") || envValue(name.slice(4)) === undefined) return undefined
  }
  return inner
}

// Classifies one top-level statement. `undefined` means "not an assignment",
// which leaves the known values alone; "unknown" means it assigns in a way this
// pass cannot prove (a condition, an operator such as `+=`, a computed value),
// which stops expansion for the call entirely.
function d2aHostAssignment(statement: Node): { name: string; value: string } | "unknown" | undefined {
  if (statement.type !== "pipeline") return "unknown"
  if (statement.namedChildCount !== 1) return "unknown"
  const expression = statement.namedChild(0)
  if (!expression || expression.type !== "assignment_expression") return undefined
  const left = expression.namedChild(0)
  const operator = expression.namedChild(1)
  const value = expression.childForFieldName("value")
  if (left?.type !== "left_assignment_expression" || operator?.type !== "assignement_operator" || !value) {
    return "unknown"
  }
  if (operator.text.trim() !== "=") return "unknown"
  const name = left.text.trim().match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)?.[1]
  if (!name) return "unknown"
  const resolved = d2aHostValue(value)
  if (resolved === undefined) return "unknown"
  // PowerShell variable names are case-insensitive.
  return { name: name.toLowerCase(), value: resolved }
}

// Collects the simple assignments that precede the call in the same top-level
// statement list. A call inside any other construct has no provable ordering or
// scope, so it keeps the literal-only handling.
function d2aHostVariables(command: Node): D2aHostVars | undefined {
  let node: Node = command
  while (
    node.parent &&
    (node.parent.type === "pipeline_chain" ||
      node.parent.type === "pipeline" ||
      node.parent.type === "redirected_statement")
  ) {
    node = node.parent
  }
  const list = node.parent
  if (!list || list.type !== "statement_list" || list.parent?.type !== "program") return undefined
  const vars = new Map<string, string>()
  for (let index = 0; index < list.childCount; index++) {
    const statement = list.child(index)
    if (!statement) continue
    if (statement.id === node.id) return vars
    if (statement.type === "comment" || statement.type === "empty_statement") continue
    const assignment = d2aHostAssignment(statement)
    if (assignment === "unknown") return undefined
    if (assignment) vars.set(assignment.name, assignment.value)
  }
  return vars
}

// Expands host variables in one path token, keeping its quoting for argPath.
// A single-quoted token stays literal (`$name` there is not a variable); the
// call is dropped when the token mixes in anything this pass cannot resolve.
function d2aExpandHostToken(text: string, vars: D2aHostVars): string | undefined {
  const quote = text.length >= 2 && text[0] === text[text.length - 1] ? text[0] : ""
  if (quote === "'") return text
  const inner = quote === '"' ? text.slice(1, -1) : text
  if (inner.includes("`") || inner.includes("${") || inner.includes("$(")) return undefined
  let unknown = false
  const replaced = inner.replace(/\$([A-Za-z_][A-Za-z0-9_:]*)/g, (match, name: string) => {
    if (name.toLowerCase().startsWith("env:")) {
      if (envValue(name.slice(4)) === undefined) unknown = true
      return match
    }
    const value = vars.get(name.toLowerCase())
    if (value === undefined) {
      unknown = true
      return match
    }
    return value
  })
  if (unknown) return undefined
  // Anything still opening a `$` is a reference this pass cannot resolve.
  if (/\$(?!env:[A-Za-z_][A-Za-z0-9_]*)/i.test(replaced)) return undefined
  return quote ? `${quote}${replaced}${quote}` : replaced
}

// Extracts the tracked controller flags. Unknown flags are ignored (the
// controller accepts more options than we observe), but a tracked flag
// without a value mirrors the controller's own failure and drops the call.
// `--run-dir` keeps its raw token because PowerShell host variables are
// expanded before path resolution.
function parseD2aControllerFlags(
  tokens: string[],
  scriptIndex: number,
): { operation: D2aOperation; runDirToken: string; stage?: number; decision?: string; result?: string } | null {
  const values: Record<string, string> = {}
  for (let index = scriptIndex + 1; index < tokens.length; index++) {
    const flag = unquote(tokens[index])
    if (!flag.startsWith("--")) continue
    const key = flag.slice(2)
    if (!D2A_TRACKED_FLAGS.has(key)) continue
    const raw = tokens[index + 1]
    if (raw === undefined || raw.startsWith("--")) return null
    values[key] = key === "run-dir" ? raw : unquote(raw)
    index += 1
  }
  if (!values.mode || !values["run-dir"] || !D2A_OPERATIONS.has(values.mode)) return null
  const call: { operation: D2aOperation; runDirToken: string; stage?: number; decision?: string; result?: string } = {
    operation: values.mode as D2aOperation,
    runDirToken: values["run-dir"],
  }
  if (call.operation !== "init" && call.operation !== "status") {
    const stage = Number(values.stage)
    if (!Number.isInteger(stage) || stage <= 0) return null
    call.stage = stage
  }
  if (call.operation === "confirm") {
    if (!["request", "accepted", "revision-requested"].includes(values.decision ?? "")) return null
    call.decision = values.decision
  }
  if (call.operation === "stage-complete") {
    if (!["passed", "blocked"].includes(values.result ?? "")) return null
    call.result = values.result
  }
  return call
}

// The run directory must resolve inside the allowed project scope, and its
// real path must stay inside too (a symlinked directory escaping the workspace
// is refused). A directory that does not exist yet is expected before init.
function probeD2aRunDir(runDir: string, instance: InstanceContext): { state: "refused" } | { state: "missing" } | { state: "ok"; runDir: string } {
  if (!containsPath(runDir, instance)) return { state: "refused" }
  if (!existsSync(runDir)) return { state: "missing" }
  let realRunDir: string
  try {
    realRunDir = realpathSync(runDir)
  } catch {
    return { state: "refused" }
  }
  if (!containsPath(realRunDir, instance)) return { state: "refused" }
  return { state: "ok", runDir: realRunDir }
}

// Best-effort summary of the raw state; every field is optional so unreadable
// or legacy (analytics-less) states degrade to "exists, revision unknown".
function summarizeD2aState(raw: Record<string, unknown>): {
  runId?: string
  revision?: number
  status?: string
  completedStages?: number[]
  startedStages: Set<number>
} {
  const analytics = raw.analytics
  const stages =
    analytics && typeof analytics === "object" && !Array.isArray(analytics) && typeof (analytics as Record<string, unknown>).stages === "object" &&
    !Array.isArray((analytics as Record<string, unknown>).stages)
      ? ((analytics as Record<string, unknown>).stages as Record<string, unknown>)
      : {}
  const startedStages = new Set<number>()
  for (const [stageKey, timing] of Object.entries(stages)) {
    if (
      timing &&
      typeof timing === "object" &&
      !Array.isArray(timing) &&
      typeof (timing as Record<string, unknown>).startedAtMs === "number"
    ) {
      const stageId = Number(stageKey)
      if (Number.isInteger(stageId) && stageId > 0) startedStages.add(stageId)
    }
  }
  const analyticsRecord = analytics && typeof analytics === "object" && !Array.isArray(analytics) ? (analytics as Record<string, unknown>) : {}
  return {
    ...(typeof analyticsRecord.runId === "string" ? { runId: analyticsRecord.runId } : {}),
    ...(typeof analyticsRecord.revision === "number" && Number.isSafeInteger(analyticsRecord.revision) && analyticsRecord.revision >= 0
      ? { revision: analyticsRecord.revision }
      : {}),
    ...(typeof raw.status === "string" ? { status: raw.status } : {}),
    ...(Array.isArray(raw.completedStages)
      ? { completedStages: raw.completedStages.filter((stage): stage is number => Number.isSafeInteger(stage) && stage > 0) }
      : {}),
    startedStages,
  }
}

// Reads the run state for probing. A symlinked state file (potential escape
// outside the run) is refused; read failures record a bare "exists" probe.
async function readD2aStateSafe(realRunDir: string): Promise<unknown> {
  const stateFile = path.join(realRunDir, "workflow-state.json")
  try {
    if (lstatSync(stateFile).isSymbolicLink()) return null
  } catch {
    return null
  }
  return await readD2aWorkflowStateFile(stateFile)
}

async function readD2aRunProbe(realRunDir: string): Promise<D2aRunProbe> {
  const raw = await readD2aStateSafe(realRunDir)
  if (raw === null || typeof raw !== "object") return { exists: true }
  return { exists: true, ...summarizeD2aState(raw as Record<string, unknown>) }
}

// ─── D2A build outcome observation ───────────────────────────────────────────
// A marked standalone build (params.d2aBuildRunDir) is collected when the
// parsed command is exactly one plain command node with no list/condition/
// pipeline/subshell wrapper around it, so the process exit code attributes to
// the build alone. The before-build run snapshot anchors the observation;
// completion time is sampled when the process truly exits.

// True when the node sits in a construct whose overall exit status cannot be
// attributed to this single command (list, condition, pipeline, subshell,
// negation, redirection is fine — it does not change the exit code chain).
// tree-sitter-powershell wraps even a plain direct call in
// statement_list > pipeline > pipeline_chain; those wrappers are accepted,
// while a second statement sibling (e.g. `; exit 3`, a flow-control node
// that overrides the exit status but is not a command node) rejects
// attribution. A real pipe or a second command surfaces as another command
// node and is rejected by the count above.
function d2aBuildAttributableCommand(root: Node): boolean {
  const commandNodes = commands(root)
  if (commandNodes.length !== 1) return false
  let node: Node | undefined = commandNodes[0]
  while (node && node.id !== root.id) {
    const parent: Node | undefined = node.parent ?? undefined
    if (!parent) break
    if (
      parent.type !== "program" &&
      parent.type !== "redirected_statement" &&
      parent.type !== "command" &&
      parent.type !== "statement_list" &&
      parent.type !== "pipeline" &&
      parent.type !== "pipeline_chain"
    ) {
      return false
    }
    if (parent.type === "statement_list") {
      for (let index = 0; index < parent.childCount; index++) {
        const sibling = parent.child(index)
        if (!sibling || sibling.id === node.id || sibling.type === "empty_statement") continue
        return false
      }
    }
    node = parent
  }
  return true
}

async function prepareD2aBuildObservation(input: {
  runDir: string
  callId: string
  instance: InstanceContext
  root: Node
}): Promise<D2aBuildObservation | undefined> {
  if (!d2aBuildAttributableCommand(input.root)) return undefined
  const dirProbe = probeD2aRunDir(input.runDir, input.instance)
  if (dirProbe.state !== "ok") return undefined
  const raw = await readD2aStateSafe(dirProbe.runDir)
  if (raw === null || typeof raw !== "object") return undefined
  const snapshot = projectD2aWorkflowState(raw)
  if (!snapshot) return undefined
  // A finished run accepts no further build observations.
  if (snapshot.status === "completed") return undefined
  return { snapshot, callId: input.callId, startedAtMs: Date.now() }
}

function d2aModelOf(ctx: Tool.Context) {
  const model = ctx.extra?.model
  if (!model || typeof model !== "object") return undefined
  const providerID = (model as Record<string, unknown>).providerID
  const id = (model as Record<string, unknown>).id
  if (typeof providerID !== "string" || !providerID || typeof id !== "string" || !id) return undefined
  // The logical model id (distinct from api.id) is what events record.
  return { providerId: providerID, modelId: id }
}

// Attribution requires the transition this call should have produced; stage
// success is never inferred from the command string or exit code alone.
function d2aTransitionMatches(
  call: D2aControllerCall,
  before: D2aRunProbe | undefined,
  after: ReturnType<typeof summarizeD2aState>,
): boolean {
  const beforeStatus = before?.exists ? before?.status : undefined
  const beforeCompleted = before?.exists ? (before?.completedStages ?? []) : []
  const beforeStarted = before?.exists ? (before?.startedStages ?? new Set<number>()) : new Set<number>()
  if (call.operation === "init") return !before?.exists
  if (call.operation === "status") return false
  if (call.operation === "stage-start") {
    return after.startedStages.has(call.stage!) && !beforeStarted.has(call.stage!)
  }
  if (call.operation === "confirm") {
    return call.decision === "request"
      ? beforeStatus !== "awaiting_confirmation" && after.status === "awaiting_confirmation"
      : beforeStatus === "awaiting_confirmation" && after.status !== "awaiting_confirmation"
  }
  if (call.result === "blocked") {
    return beforeStatus !== "blocked" && after.status === "blocked"
  }
  return !beforeCompleted.includes(call.stage!) && (after.completedStages ?? []).includes(call.stage!)
}

async function buildD2aShellSnapshots(input: {
  calls: D2aControllerCall[]
  before: Map<string, D2aRunProbe>
  instance: InstanceContext
  model: { providerId: string; modelId: string } | undefined
  exit: number | null
  totalCommands: number
}): Promise<{ snapshots: D2aShellSnapshot[]; diagnostics: string[] }> {
  const snapshots: D2aShellSnapshot[] = []
  const diagnostics: string[] = []
  const callsByRun = new Map<string, D2aControllerCall[]>()
  for (const call of input.calls) {
    const group = callsByRun.get(call.runDir)
    if (group) group.push(call)
    else callsByRun.set(call.runDir, [call])
  }
  for (const [runDir, runCalls] of callsByRun) {
    const dirProbe = probeD2aRunDir(runDir, input.instance)
    if (dirProbe.state === "refused") {
      diagnostics.push("d2a observation skipped: run directory escapes the allowed project scope")
      continue
    }
    if (dirProbe.state === "missing") {
      // init never created (or failed to create) the run directory; nothing to observe.
      continue
    }
    const raw = await readD2aStateSafe(dirProbe.runDir)
    if (raw === null || typeof raw !== "object") {
      diagnostics.push("d2a observation skipped: workflow-state.json is missing or unreadable")
      continue
    }
    const snapshot = projectD2aWorkflowState(raw)
    if (!snapshot) {
      diagnostics.push("d2a observation skipped: workflow-state.json failed whitelist projection")
      continue
    }
    const after = summarizeD2aState(raw as Record<string, unknown>)
    const before = input.before.get(runDir)
    const beforeRevision = before?.exists && before.refused !== true ? before?.revision : undefined
    const committed =
      beforeRevision !== undefined
        ? after.revision === beforeRevision + 1
        : after.revision === 1 && (!before || !before.exists || (before.refused !== true && before.revision === undefined))
    const single = runCalls.length === 1 ? runCalls[0] : undefined
    const attributable =
      committed &&
      single !== undefined &&
      single.operation !== "status" &&
      input.model !== undefined &&
      d2aTransitionMatches(single, before, after) &&
      (input.totalCommands === 1 ? input.exit === 0 : true)
    snapshots.push({
      ...(single ? { operation: single.operation } : {}),
      replayed: !attributable,
      ...(attributable && input.model ? { model: input.model } : {}),
      snapshot,
    })
    // 采集起点标记：执行前无状态、执行后是合法的新 run（revision 1）、
    // 单命令且正常零退出——即一次真实 init。与有无模型信息解耦。
    if (
      single?.operation === "init" &&
      !before?.exists &&
      snapshot.revision === 1 &&
      input.totalCommands === 1 &&
      input.exit === 0
    ) {
      snapshots[snapshots.length - 1].buildTrackingStartedAtInit = true
    }
  }
  return { snapshots, diagnostics }
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

export function resolveSandboxWorkspaceRoots(cwd: string, roots: readonly string[]) {
  const resolved = [cwd, ...roots].map((root) => {
    if (root === "~") return os.homedir()
    if (root.startsWith("~/") || root.startsWith("~\\")) return path.resolve(os.homedir(), root.slice(2))
    return path.resolve(cwd, root)
  })
  return resolved.filter((root, index) => {
    const key = process.platform === "win32" ? root.toLowerCase() : root
    return (
      resolved.findIndex(
        (candidate) => (process.platform === "win32" ? candidate.toLowerCase() : candidate) === key,
      ) === index
    )
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
      NativeSandboxRuntime.new({ state_dir: Sandbox.STATE_DIR, bundled_executables_dir: null }),
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

    // Recognizes built-in Node Controller invocations on the same parsed tree:
    // an interpreter token, the controller script resolved to the built-in
    // install (or dev resources) location, and the tracked flags.
    const detectD2aCalls = Effect.fn("ShellTool.detectD2aCalls")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
    ) {
      const controllerPaths = yield* Effect.promise(() => d2aControllerScriptRealpaths())
      if (controllerPaths.size === 0) return []
      const calls: D2aControllerCall[] = []
      for (const node of commands(root)) {
        const tokens = d2aCommandTokens(node)
        if (tokens.length < 2 || !isD2aInterpreterToken(tokens[0])) continue
        // Only PowerShell needs host-variable expansion; every other shell keeps
        // the literal tokens that argPath already resolves.
        const vars = ps ? d2aHostVariables(node) : undefined
        let scriptIndex = -1
        for (let index = 1; index < tokens.length; index++) {
          const text = unquote(tokens[index])
          if (text.startsWith("-")) continue
          scriptIndex = index
          break
        }
        if (scriptIndex === -1) continue
        const scriptArg = vars ? d2aExpandHostToken(tokens[scriptIndex], vars) : tokens[scriptIndex]
        if (scriptArg === undefined) continue
        const scriptPath = yield* argPath(scriptArg, cwd, ps, shell)
        if (!scriptPath) continue
        const realScript = yield* Effect.promise(async () => {
          try {
            return realpathSync(scriptPath)
          } catch {
            return undefined
          }
        })
        if (!realScript || !controllerPaths.has(d2aPathKey(realScript))) continue
        const flags = parseD2aControllerFlags(tokens, scriptIndex)
        if (!flags) continue
        const runDirArg = vars ? d2aExpandHostToken(flags.runDirToken, vars) : flags.runDirToken
        if (runDirArg === undefined) continue
        const runDir = yield* argPath(runDirArg, cwd, ps, shell)
        if (!runDir) continue
        calls.push({
          operation: flags.operation,
          runDir,
          ...(flags.stage !== undefined ? { stage: flags.stage } : {}),
          ...(flags.decision !== undefined ? { decision: flags.decision } : {}),
          ...(flags.result !== undefined ? { result: flags.result } : {}),
        })
      }
      return calls
    })

    const readD2aBeforeProbes = Effect.fn("ShellTool.readD2aBeforeProbes")(function* (
      calls: D2aControllerCall[],
      instance: InstanceContext,
    ) {
      const before = new Map<string, D2aRunProbe>()
      for (const runDir of new Set(calls.map((call) => call.runDir))) {
        const dirProbe = probeD2aRunDir(runDir, instance)
        if (dirProbe.state === "refused") {
          before.set(runDir, { exists: false, refused: true })
          continue
        }
        if (dirProbe.state === "missing") {
          before.set(runDir, { exists: false })
          continue
        }
        before.set(runDir, yield* Effect.promise(() => readD2aRunProbe(dirProbe.runDir)))
      }
      return before
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string, directory: string) {
      if (!process.env.DEVECO_HOME?.trim()) {
        const home = yield* Effect.promise(loadSavedDevEcoHome)
        if (home) process.env.DEVECO_HOME = home
      }
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
        console.warn(
          `[sandbox] Failed to read config file ${filepath}:`,
          err instanceof Error ? err.message : String(err),
        )
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
    const resolveRuntimeEnvLayer = Effect.fn("ShellTool.resolveRuntimeEnvLayer")(function* () {
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
    })

    const resolveSandboxProfile = Effect.fn("ShellTool.resolveSandboxProfile")(function* (
      cwd: string,
      agentSandbox?: ConfigSandbox.SandboxConfig,
    ) {
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
        layers.project = layers.project ? mergeSandboxConfig(layers.project, agentSandbox) : agentSandbox
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
      // Linux remains direct execution until its npm runtime is shipped.
      const requestId = `sbx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // Sanitized command tag: first command word, skipping env var assignments
      // (FR-OBS-001: no unsanitized argv, env vars, user paths, or file content)
      const commandTag = (() => {
        const tokens = input.command.trim().split(/\s+/)
        for (const token of tokens) {
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
          return token || "unknown"
        }
        return "unknown"
      })()
      const sandboxStartTime = Date.now()
      const isMac = process.platform === "darwin"
      const isWindows = process.platform === "win32"
      const isSandboxPlatform = isMac || isWindows
      state.requestId = requestId
      state.sandboxStartTime = sandboxStartTime

      // FR-OBS-001: Record started event before any sandbox work so config
      // failures still produce a start event. Only one start event per request.
      yield* Effect.logInfo(
        `sandbox_request_started request_id=${requestId} capability=${isMac ? "macos-seatbelt" : isWindows ? "windows-unelevated" : "none"} platform=${process.platform} profile_type=pending network_state=pending command_tag=${commandTag}`,
      )

      // FR-CFG-010/011: Load and validate sandbox config before executing any command.
      // Config errors (config_invalid) cause the command to be rejected — fail closed.
      // Linux falls through to direct execution. Windows and macOS fail closed
      // when a selected managed profile cannot be prepared.
      let profile: ResolvedProfile | undefined
      if (isSandboxPlatform) {
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
        profile =
          resolvedProfile.profile_id === "full-access"
            ? resolvedProfile
            : {
                ...resolvedProfile,
                workspace_roots: isWindows
                  ? resolveSandboxWorkspaceRoots(input.cwd, resolvedProfile.workspace_roots)
                  : resolvedProfile.workspace_roots.length === 0
                    ? [input.cwd]
                    : resolvedProfile.workspace_roots,
              }
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
          const injectedProfile = HdcHostEnforcement.injectHostEnforcement(
            profile,
            protectedBins,
            input.env.DEVECO_CODE_HDC_ENDPOINT,
          )
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
      if (isSandboxPlatform && profile && profile.profile_id !== "full-access") {
        const prepareRequest = toNativePrepareRequest(profile, {
          executable: input.shell,
          args: isWindows ? Shell.args(input.shell, input.command, input.cwd) : ["-c", input.command],
          cwd: input.cwd,
          env: Object.fromEntries(Object.entries(input.env).filter(([, v]) => v !== undefined)) as Record<
            string,
            string
          >,
        })

        const prepareStartTime = Date.now()
        const prepared = yield* Effect.tryPromise({
          try: () => nativeRuntime().prepare(prepareRequest),
          catch: (err) =>
            new Sandbox.SandboxError({
              code: err instanceof NativeSandboxError ? err.code : "PrepareFailed",
              phase: err instanceof NativeSandboxError ? err.phase : "Prepare",
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

      const enforcementResult = isSandboxPlatform
        ? profile?.profile_id === "full-access"
          ? "bypassed"
          : "applied"
        : "bypassed"
      const executionResult =
        exit.kind === "exit"
          ? exit.code === 0
            ? "success"
            : "failed"
          : exit.kind === "timeout"
            ? "timeout"
            : "cancelled"
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
      yield* Effect.logInfo(`sandbox_request_finished ${finishedParts.join(" ")}`)

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
    function detectSandboxDenial(
      stderr: string,
      profileId?: string,
      networkEnabled?: boolean,
    ): "file" | "network" | null {
      if (!profileId || profileId === "full-access") return null
      // Seatbelt write/exit denials appear as "operation not permitted".
      if (/operation not permitted/i.test(stderr)) return "file"
      // Network blocked by sandbox profile.
      if (
        !networkEnabled &&
        /connection refused|network unreachable|could not resolve host|network is down/i.test(stderr)
      )
        return "network"
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
      const raw = state.list.map((item) => item.text).join("")
      // Compute sandbox denial hint once; reused in both meta (LLM) and UI output.
      const denial =
        code !== null && code !== 0 && state.sandboxProfileId
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
          : state.aborted
            ? ["User aborted the command"]
            : []),
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
      const output = truncated + (end.text || "(no output)") + metadata
      // UI display: replace <shell_metadata> block with single-line [SANDBOX] hint
      // so users see a concise, structured prefix per industry logging conventions.
      const metadataOutput = preview(
        output.includes("<shell_metadata>") && sandboxHint
          ? output.replace(/<shell_metadata>[\s\S]*?<\/shell_metadata>/, sandboxHint)
          : output,
      )
      // Post-execution state read: project each observed run to the whitelist
      // snapshot and attach it for tool.execute.after consumers (analytics).
      // Failures produce fixed diagnostics and never change the tool result.
      let d2aWorkflowSnapshots: D2aShellSnapshot[] = []
      if (input.d2a.calls.length > 0) {
        const observed = yield* Effect.promise(() =>
          buildD2aShellSnapshots({
            calls: input.d2a.calls,
            before: input.d2a.before,
            instance: input.d2a.instance,
            model: d2aModelOf(ctx),
            exit: code,
            totalCommands: input.d2a.totalCommands,
          }),
        )
        d2aWorkflowSnapshots = observed.snapshots
        for (const diagnostic of observed.diagnostics) {
          yield* Effect.logInfo(diagnostic)
        }
      }
      // A marked standalone build exited: emit its outcome observation. Only a
      // real process exit produces a result; cancel/timeout stays skipped. The
      // completedAtMs timestamp is sampled at result assembly right after the
      // process exited, which is the ordering key the storage merge uses.
      // The boolean only needs the 0/non-zero distinction. Windows PowerShell
      // 5.1's -Command wrapper collapses a failing final native command's
      // numeric code to 1 but never to 0; deliberately no `exit $LASTEXITCODE`
      // fix-up — a failing PowerShell command that never sets $LASTEXITCODE
      // would exit 0 there and be recorded as a false success.
      if (input.d2a.build && code !== null) {
        d2aWorkflowSnapshots.push({
          replayed: true,
          snapshot: input.d2a.build.snapshot,
          buildResult: {
            callId: input.d2a.build.callId,
            completedAtMs: Date.now(),
            success: code === 0,
          },
        })
      }
      // 宿主归属只留在本地 metadata：会话、assistant message、工具调用身份和
      // 已验证工程的包名，供插件把工具与 Token 观测并进同一个运行。用户消息
      // 由插件按 message.updated 的 parentID 解析，Shell 看不到消息序列。
      if (d2aWorkflowSnapshots.length > 0) {
        const bundleName = readBundleName(input.d2a.instance.directory)
        const binding: D2aObservationBinding = {
          sessionID: ctx.sessionID,
          ...(ctx.messageID ? { messageID: ctx.messageID } : {}),
          ...(ctx.callID ? { callID: ctx.callID } : {}),
          ...(bundleName ? { bundleName } : {}),
        }
        d2aWorkflowSnapshots = d2aWorkflowSnapshots.map((observation) => ({ ...observation, binding }))
      }
      return {
        title: input.description,
        metadata: {
          output: metadataOutput,
          exit: code,
          description: input.description,
          truncated: state.cut,
          ...(state.cut && state.file ? { outputPath: state.file } : {}),
          ...(d2aWorkflowSnapshots.length > 0 ? { d2aWorkflowSnapshots } : {}),
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
              yield* ctx.metadata({
                metadata: { output: `[sandbox error] [${err.code}] ${err.message}`, description: input.description },
              })
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
            yield* ctx.metadata({
              metadata: {
                output: `[shell error] ${err instanceof Error ? err.message : String(err)}`,
                description: input.description,
              },
            })
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
              const d2aCalls = yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                  // Controller recognition rides the same parsed tree and
                  // permission context; only detections that survive
                  // path resolution and flag parsing are observed.
                  const calls = yield* detectD2aCalls(tree.rootNode, cwd, ps, shell)
                  // The marked build observation rides the same tree; the run
                  // dir resolves with Shell workdir semantics. An invalid
                  // marker or a non-attributable command form only skips
                  // collection — the command itself still runs.
                  const resolvedBuildRunDir = params.d2aBuildRunDir
                    ? yield* resolvePath(params.d2aBuildRunDir, cwd, shell)
                    : undefined
                  const buildRunDir = resolvedBuildRunDir || params.d2aBuildRunDir
                  const build =
                    buildRunDir !== undefined && ctx.callID
                      ? yield* Effect.promise(() =>
                          prepareD2aBuildObservation({
                            runDir: buildRunDir,
                            callId: ctx.callID!,
                            instance: instanceCtx,
                            root: tree.rootNode,
                          }),
                        )
                      : undefined
                  return { calls, build, totalCommands: commands(tree.rootNode).length, tree }
                }),
              )
              const d2aBefore = yield* readD2aBeforeProbes(d2aCalls.calls, instanceCtx)

              const env: NodeJS.ProcessEnv = { ...(yield* shellEnv(ctx, cwd, instanceCtx.directory)) }
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
                  d2a: {
                    calls: d2aCalls.calls,
                    before: d2aBefore,
                    totalCommands: d2aCalls.totalCommands,
                    instance: instanceCtx,
                    ...(d2aCalls.build ? { build: d2aCalls.build } : {}),
                  },
                },
                ctx,
              )
            }),
        }
      })
  }),
)
