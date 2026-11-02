import fs from "fs/promises"
import { constants } from "fs"
import path from "path"
import stripAnsi from "strip-ansi"
import { Global } from "@opencode-ai/core/global"
import { formatBuildProjectOutput, TRUNCATE_NOTICE } from "@/tool/lib/build-project-output"
import { runBundledDevecoCli } from "@/tool/lib/deveco-cli"
import { findDevEcoHome, hdcPath } from "@/tool/lib/env"
import { resolveCliInvocation } from "./commands"
import { DEVECO_CLI_EVENT_FILE, type DevecoCliEvent } from "./event"

export type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type CliRunner = (args: string[], cwd: string, options?: { skipVersionCheck?: boolean }) => Promise<CliResult>

export const MAX_DOCS_OUTPUT_LENGTH = 5_000

// The devecocli command-identity policy (allowlist + usage-token rule) is dependency-free and
// lives in ./commands; this module only consumes it when writing an event.

type CreateTargetState = "missing" | "empty" | "non-empty" | "invalid"

type ProjectEntry = {
  relative: string
  kind: "directory" | "file"
}

type Device = {
  name: string
  serial?: string
  kind: "physical" | "emulator"
  status: "running" | "stopped"
}

type SelectedDevice = Device & { serial: string }

type ProxyDependencies = {
  findHome?: () => Promise<string | undefined>
  runCommand?: (cmd: string[]) => Promise<CliResult>
  waitEmulatorReady?: (name: string, before: Device[]) => Promise<string>
}

const SPECIAL_RUN_FLAGS = new Set(["--apply", "--hotreload", "--hotreload-apply", "--help", "-h"])
const KNOWN_RUN_FLAGS = new Set([
  "--module",
  "--device",
  "--product",
  "--build-mode",
  "--ability",
  "--uninstall",
  "--skip-build",
])

export async function executeDevecoCliProxy(
  args: string[],
  cwd: string,
  runner: CliRunner = runBundledDevecoCli,
  dependencies: ProxyDependencies = {},
): Promise<CliResult & { fullOutput?: string }> {
  if (args[0] === "log" && args[1] === "clear") {
    return executeLogClear(args.slice(2), cwd, runner, dependencies)
  }
  if (args[0] === "log" && !args.some((arg) => arg === "--help" || arg === "-h")) {
    const invalid = validateLogTail(args.slice(1))
    if (invalid) return invalid
    args = enhanceLogArgs(args)
  }
  if (args[0] === "create") {
    if (args.some((arg) => arg === "--help" || arg === "-h")) {
      return enhanceCreateHelp(
        await runner(
          args.filter((arg) => arg !== "--merge"),
          cwd,
        ),
      )
    }
    return executeCreate(args.slice(1), cwd, runner).catch((error) => projectCreateFailed(error))
  }
  if (args[0] === "docs" && (args[1] === "search" || args[1] === "read")) {
    return truncateDocsOutput(await runner(args, cwd))
  }
  if (args[0] === "build" && !args.some((arg) => arg === "--help" || arg === "-h")) {
    return executeBuild(args, cwd, runner)
  }
  if (args[0] === "run" && shouldEnhanceRun(args.slice(1))) {
    return executeRun(args, cwd, runner, dependencies)
  }
  return runner(args, cwd)
}

function validateLogTail(args: string[]): CliResult | undefined {
  const values = args.flatMap((arg, index) => {
    if (arg === "--tail") return [args[index + 1]]
    if (arg.startsWith("--tail=")) return [arg.slice("--tail=".length)]
    return []
  })
  if (values.length === 0) return undefined
  if (values.every((value) => /^[1-9]\d*$/.test(value ?? ""))) return undefined
  return {
    stdout: "",
    stderr: "`tail` must be a positive integer.\n",
    exitCode: 1,
  }
}

export const DEFAULT_LOG_TAIL = 2_000

function enhanceLogArgs(args: string[]) {
  const hasWindow = args.some((arg) =>
    ["--tail", "--from", "--to", "--follow", "--crash"].some(
      (option) => arg === option || arg.startsWith(`${option}=`),
    ),
  )
  return [...args, ...(hasWindow ? [] : ["--tail", String(DEFAULT_LOG_TAIL)])]
}

async function truncateDocsOutput(result: CliResult) {
  if (result.stdout.length + result.stderr.length <= MAX_DOCS_OUTPUT_LENGTH) return result
  const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout.endsWith("\n") ? "" : "\n")
  // Identical responses reuse a path so repeated lookups do not add changing paths to context.
  const file = path.join(
    Global.Path.tmp,
    "devecocli",
    `docs-${new Bun.CryptoHasher("sha256").update(output).digest("hex")}.txt`,
  )
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, output)
  const notice = `[Documentation output truncated to ${MAX_DOCS_OUTPUT_LENGTH} characters.]\nFull output saved to: ${file}\n\n`
  const truncated = `${notice}${output.slice(0, MAX_DOCS_OUTPUT_LENGTH - notice.length - 1)}\n`
  if (!result.stdout) return { ...result, stderr: truncated }
  return { ...result, stdout: truncated, stderr: "" }
}

export async function runDevecoCliProxy(args: string[], cwd: string, runner: CliRunner = runBundledDevecoCli) {
  const started = Date.now()
  const result = await executeDevecoCliProxy(args, cwd, runner)
  await writeCliEvent(args, result, Date.now() - started).catch(() => undefined)
  const output = result.fullOutput ? await persistFullOutput(result) : result.stdout
  if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`)
  if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`)
  return result.exitCode
}

async function executeLogClear(
  args: string[],
  cwd: string,
  runner: CliRunner,
  dependencies: ProxyDependencies,
): Promise<CliResult> {
  const target = optionValue(args, "--device")
  if (!validLogClearArgs(args, target)) return logClearUsage()

  const home = await (dependencies.findHome ?? findDevEcoHome)()
  if (!home) return logClearError("DevEco Studio path not found. Set DEVECO_HOME and retry.")
  const hdc = hdcPath(home)
  if (!(await Bun.file(hdc).exists())) return logClearError(`hdc not found: ${hdc}`)

  const discovery = await runner(["device", "list", "--format", "json"], cwd, { skipVersionCheck: true })
  if (discovery.exitCode !== 0) return discovery
  const devices = parseDevices(discovery.stdout)
  if (!devices) return logClearError("Unable to parse connected devices. No logs were cleared.")
  const device = selectLogClearDevice(devices, target)
  if ("exitCode" in device) return device
  const result = await (dependencies.runCommand ?? runCommand)([hdc, "-t", device.serial, "shell", "hilog", "-r"])
  if (result.exitCode !== 0) return result
  // HDC can report transport failures in stdout while exiting successfully.
  if (logClearReportedFailure(result)) return { ...result, exitCode: 1 }
  return {
    stdout: `Device log buffer cleared.\ndevice: ${device.name} (${device.serial})\n`,
    stderr: result.stderr,
    exitCode: 0,
  }
}

function validLogClearArgs(args: string[], target: string | undefined) {
  if (args.length === 0) return true
  if (!target || target.startsWith("-")) return false
  return (args.length === 2 && args[0] === "--device") || (args.length === 1 && args[0].startsWith("--device="))
}

function logClearUsage(): CliResult {
  return logClearError("Usage: devecocli log clear [--device <name-or-serial>]")
}

function logClearError(stderr: string): CliResult {
  return { stdout: "", stderr: `${stderr}\n`, exitCode: 1 }
}

function selectLogClearDevice(devices: Device[], target: string | undefined): SelectedDevice | CliResult {
  // Prefer an exact serial over a display name, and never clear an ambiguous/default target.
  const candidates = !target
    ? devices
    : devices.some((device) => device.serial === target)
      ? devices.filter((device) => device.serial === target)
      : devices.filter((device) => device.name === target)
  if (candidates.length !== 1) {
    return logClearError(
      [
        candidates.length > 1 ? "DEVICE_SELECTION_REQUIRED" : target ? "DEVICE_NOT_FOUND" : "NO_DEVICE_AVAILABLE",
        "No logs were cleared. Connect a device and select a unique serial.",
        ...devices.map((device) => `- ${device.name}${device.serial ? ` (${device.serial})` : ""}`),
        "Retry with `devecocli log clear --device <serial>`.",
      ].join("\n"),
    )
  }
  if (!candidates[0].serial) {
    return logClearError("DEVICE_SERIAL_UNAVAILABLE\nNo logs were cleared. Refresh the device list and retry.")
  }
  return candidates[0] as SelectedDevice
}

function logClearReportedFailure(result: CliResult) {
  return /\[(?:fail|error)\]|\bfail(?:ed|ure)?\b|^\s*error\b/im.test(stripAnsi(`${result.stdout}\n${result.stderr}`))
}

async function executeCreate(args: string[], cwd: string, runner: CliRunner): Promise<CliResult> {
  const merge = args.includes("--merge")
  const forwarded = args.filter((arg) => arg !== "--merge")
  const appName = optionValue(args, "--app-name")
  if (!appName) return runner(["create", ...forwarded], cwd)
  const projectPath = optionValue(args, "--project-path")
  const target = path.resolve(cwd, projectPath ?? appName)
  const state = await createTargetState(target)
  if (state === "invalid" || (state === "non-empty" && !merge)) return projectExists(target, merge)
  if (state !== "non-empty") {
    return runner(
      ["create", ...(projectPath === undefined ? forwarded : setOption(forwarded, "--project-path", target))],
      cwd,
    )
  }

  const staging = await fs.mkdtemp(path.join(path.dirname(target), `.${path.basename(target)}.deveco-create-`))
  try {
    await fs.chmod(staging, 0o700)
    return await createStagedProject(forwarded, cwd, target, staging, runner)
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function createStagedProject(args: string[], cwd: string, target: string, staging: string, runner: CliRunner) {
  const result = replaceCreatePath(
    await runner(["create", ...setOption(args, "--project-path", staging)], cwd),
    staging,
    target,
  )
  if (result.exitCode !== 0) return result
  const conflicts = await mergeProject(staging, target)
  if (conflicts.length > 0) return projectFileConflict(target, conflicts)
  return {
    ...result,
    stdout: `${[result.stdout.trimEnd(), `Preserved existing content in: ${target}`].filter(Boolean).join("\n")}\n`,
  }
}

async function createTargetState(target: string): Promise<CreateTargetState> {
  const stat = await fs.lstat(target).catch(() => undefined)
  if (!stat) return "missing"
  if (!stat.isDirectory()) return "invalid"
  return (await fs.readdir(target)).length === 0 ? "empty" : "non-empty"
}

async function mergeProject(source: string, target: string) {
  const entries = await listProjectEntries(source)
  const conflicts = await projectConflicts(entries, target)
  if (conflicts.length > 0) return conflicts.sort()
  return copyProjectEntries(entries, source, target)
}

async function projectConflicts(entries: ProjectEntry[], target: string) {
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const stat = await fs.lstat(path.join(target, entry.relative)).catch(() => undefined)
        return !stat || (entry.kind === "directory" && stat.isDirectory()) ? [] : [entry.relative]
      }),
    )
  ).flat()
}

async function copyProjectEntries(entries: ProjectEntry[], source: string, target: string) {
  const createdFiles: string[] = []
  const createdDirectories: string[] = []
  for (const entry of entries.filter((entry) => entry.kind === "directory")) {
    const destination = path.join(target, entry.relative)
    const stat = await fs.lstat(destination).catch(() => undefined)
    if (stat?.isDirectory()) continue
    const created = await fs.mkdir(destination).then(
      () => true,
      () => false,
    )
    if (!created) {
      await rollbackMerge(createdFiles, createdDirectories)
      return [entry.relative]
    }
    createdDirectories.push(destination)
  }

  for (const entry of entries.filter((entry) => entry.kind === "file")) {
    const destination = path.join(target, entry.relative)
    const created = await fs.copyFile(path.join(source, entry.relative), destination, constants.COPYFILE_EXCL).then(
      () => true,
      () => false,
    )
    if (!created) {
      await rollbackMerge(createdFiles, createdDirectories)
      return [entry.relative]
    }
    createdFiles.push(destination)
  }
  return []
}

async function listProjectEntries(root: string, directory = root): Promise<ProjectEntry[]> {
  return (
    await Promise.all(
      (await fs.readdir(directory, { withFileTypes: true })).map(async (entry) => {
        const absolute = path.join(directory, entry.name)
        const relative = path.relative(root, absolute)
        if (entry.isDirectory()) {
          return [{ relative, kind: "directory" as const }, ...(await listProjectEntries(root, absolute))]
        }
        if (entry.isFile()) return [{ relative, kind: "file" as const }]
        throw new Error(`Unsupported generated project entry: ${relative}`)
      }),
    )
  ).flat()
}

async function rollbackMerge(files: string[], directories: string[]) {
  await Promise.all(files.map((file) => fs.rm(file, { force: true }).catch(() => undefined)))
  for (const directory of directories.reverse()) await fs.rmdir(directory).catch(() => undefined)
}

function projectExists(target: string, merge: boolean): CliResult {
  return {
    stdout: "",
    stderr: `${JSON.stringify(
      {
        code: "PROJECT_EXISTS",
        message: `Target "${target}" already exists and is not empty.`,
        hint: merge
          ? "Choose a directory target before retrying with --merge."
          : "Retry with --merge to preserve existing content, or ask the user whether to overwrite, rename, or cancel.",
        details: { targetRoot: target },
      },
      null,
      2,
    )}\n`,
    exitCode: 2,
  }
}

function projectFileConflict(target: string, conflicts: string[]): CliResult {
  return {
    stdout: "",
    stderr: `${JSON.stringify(
      {
        code: "PROJECT_FILE_CONFLICT",
        message: "Generated project files conflict with existing content.",
        hint: "Rename the conflicting files, choose another project path, or cancel. No existing files were changed.",
        details: { targetRoot: target, conflicts },
      },
      null,
      2,
    )}\n`,
    exitCode: 2,
  }
}

function projectCreateFailed(error: unknown): CliResult {
  return {
    stdout: "",
    stderr: `${JSON.stringify(
      {
        code: "PROJECT_CREATE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    )}\n`,
    exitCode: 1,
  }
}

function setOption(args: string[], option: string, value: string) {
  const index = args.findIndex((arg) => arg === option || arg.startsWith(`${option}=`))
  if (index < 0) return [...args, option, value]
  if (args[index] === option) return args.map((arg, current) => (current === index + 1 ? value : arg))
  return args.map((arg, current) => (current === index ? `${option}=${value}` : arg))
}

function replaceCreatePath(result: CliResult, source: string, target: string): CliResult {
  return {
    ...result,
    stdout: result.stdout.replaceAll(source, target),
    stderr: result.stderr.replaceAll(source, target),
  }
}

function enhanceCreateHelp(result: CliResult): CliResult {
  if (result.exitCode !== 0 || result.stdout.includes("--merge")) return result
  return {
    ...result,
    stdout: `${result.stdout.trimEnd()}\n  --merge                  Preserve existing content and fail on generated file conflicts\n`,
  }
}

async function runCommand(cmd: string[]): Promise<CliResult> {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? Bun.readableStreamToText(proc.stdout) : Promise.resolve(""),
    proc.stderr ? Bun.readableStreamToText(proc.stderr) : Promise.resolve(""),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function writeCliEvent(args: string[], result: CliResult, durationMs: number) {
  const file = process.env[DEVECO_CLI_EVENT_FILE]
  if (!file) return
  const invocation = resolveCliInvocation(args)
  if (!invocation) return
  const projectRoot =
    invocation.command === "create" && result.exitCode === 0 ? readProjectRoot(result.stdout) : undefined
  const event: DevecoCliEvent = {
    command: invocation.command,
    ...(invocation.subcommand ? { subcommand: invocation.subcommand } : {}),
    exitCode: result.exitCode,
    durationMs,
    ...(projectRoot ? { projectRoot } : {}),
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(event)}\n`, "utf8")
}

function readProjectRoot(output: string) {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.match(/^Project root:\s*(.+)\s*$/)?.[1]?.trim())
    .find((item): item is string => Boolean(item))
}

async function executeBuild(args: string[], cwd: string, runner: CliRunner) {
  const result = await runner(args, cwd)
  const formatted = formatBuildProjectOutput(result)
  return {
    stdout: formatted.text,
    stderr: "",
    exitCode: result.exitCode,
    ...(formatted.truncated ? { fullOutput: formatted.full } : {}),
  }
}

async function executeRun(
  args: string[],
  cwd: string,
  runner: CliRunner,
  dependencies: ProxyDependencies,
): Promise<CliResult> {
  const deviceList = await runner(["device", "list", "--format", "json"], cwd, { skipVersionCheck: true })
  if (deviceList.exitCode !== 0) return runner(args, cwd)

  const target = optionValue(args, "--device")
  const active = parseDevices(deviceList.stdout)
  if (!active) return runner(args, cwd)
  if (target && active.some((device) => matches(device, target))) return runner(args, cwd)

  const emulatorList = await runner(["emulator", "list", "--format", "json"], cwd, { skipVersionCheck: true })
  if (emulatorList.exitCode !== 0) return runner(args, cwd)

  const emulators = parseEmulators(emulatorList.stdout)
  if (!emulators) return runner(args, cwd)
  if (!target) {
    const devices = mergeDevices(active, emulators)
    if (devices.length !== 1) return selectionRequired(devices)
    const device = devices[0]
    const runArgs = [...args, "--device", device.serial ?? device.name]
    if (device.status === "running") return runner(runArgs, cwd)
    return startEmulatorAndRun(device, runArgs, cwd, runner, active, dependencies)
  }

  const emulator = emulators.find((device) => matches(device, target))
  if (!emulator) return runner(args, cwd)
  if (emulator.status === "running") return runner(args, cwd)

  return startEmulatorAndRun(emulator, args, cwd, runner, active, dependencies)
}

const EMULATOR_READY_TIMEOUT_MS = 120_000
const EMULATOR_READY_POLL_INTERVAL_MS = 3_000
const EMULATOR_READY_PROBE_TIMEOUT_MS = 10_000

// `emulator start` returns as soon as the emulator process is launched, but
// hdc cannot install or launch until the transport is up and the device has
// booted. Polling `hdc list targets` for a target that was not connected
// before the start bridges that cold-boot gap so the subsequent `run` does not
// block indefinitely on an unreachable target.
async function waitEmulatorReady(name: string, before: Device[]): Promise<string> {
  const home = await findDevEcoHome()
  if (!home) return ""
  const hdc = hdcPath(home)
  if (!(await Bun.file(hdc).exists())) return ""
  const known = new Set(before.flatMap((device) => [device.serial, device.name]).filter((v): v is string => Boolean(v)))
  const deadline = Date.now() + EMULATOR_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const fresh = (await probeHdcTargets(hdc, EMULATOR_READY_PROBE_TIMEOUT_MS)).find(
      (serial) => !known.has(serial),
    )
    if (fresh) return `Emulator "${name}" is reachable on hdc target ${fresh}.`
    await Bun.sleep(EMULATOR_READY_POLL_INTERVAL_MS)
  }
  return `Emulator "${name}" started, but hdc reported no new target within ${EMULATOR_READY_TIMEOUT_MS / 1000}s; proceeding may fail.`
}

async function probeHdcTargets(hdc: string, timeoutMs: number): Promise<string[]> {
  const proc = Bun.spawn({ cmd: [hdc, "list", "targets"], stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const stdout = proc.stdout ? await Bun.readableStreamToText(proc.stdout) : ""
    await proc.exited
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function startEmulatorAndRun(
  device: Device,
  args: string[],
  cwd: string,
  runner: CliRunner,
  before: Device[],
  dependencies: ProxyDependencies,
) {
  const start = await runner(["emulator", "start", device.name], cwd, { skipVersionCheck: true })
  if (start.exitCode !== 0) {
    return { stdout: commandOutput(["emulator", "start", device.name], start), stderr: "", exitCode: start.exitCode }
  }
  const ready = await (dependencies.waitEmulatorReady ?? waitEmulatorReady)(device.name, before)
  const run = await runner(args, cwd)
  return {
    stdout: [commandOutput(["emulator", "start", device.name], start), ready, commandOutput(args, run)]
      .filter(Boolean)
      .join("\n\n"),
    stderr: "",
    exitCode: run.exitCode,
  }
}

async function persistFullOutput(result: CliResult & { fullOutput?: string }) {
  const dir = path.join(Global.Path.tmp, "devecocli")
  const file = path.join(dir, `build-${Date.now()}-${process.pid}.log`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, result.fullOutput!, "utf8")
  return `${TRUNCATE_NOTICE}\n\nFull output saved to: ${file}\n\n${result.stdout.replace(`${TRUNCATE_NOTICE}\n`, "")}`
}

function parseDevices(output: string): Device[] | undefined {
  return parseRows(output)?.flatMap((row) => {
    const name = stringValue(row.name)
    if (!name) return []
    return [
      {
        name,
        serial: serialValue(row.serial),
        kind: stringValue(row.kind)?.toLowerCase() === "emulator" ? ("emulator" as const) : ("physical" as const),
        status: "running" as const,
      },
    ]
  })
}

function parseEmulators(output: string): Device[] | undefined {
  return parseRows(output)?.flatMap((row) => {
    const name = stringValue(row.name)
    if (!name) return []
    const status = stringValue(row.status)?.toLowerCase()
    return [
      {
        name,
        serial: serialValue(row.serial),
        kind: "emulator" as const,
        status: status === "running" || status === "started" ? ("running" as const) : ("stopped" as const),
      },
    ]
  })
}

function parseRows(output: string): Record<string, unknown>[] | undefined {
  try {
    const text = stripAnsi(output).trim()
    const end = text.lastIndexOf("]")
    if (!text.startsWith("[") || end < 0) return undefined
    const value: unknown = JSON.parse(text.slice(0, end + 1))
    if (!Array.isArray(value)) return undefined
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
  } catch {
    return undefined
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function serialValue(value: unknown) {
  const serial = stringValue(value)
  return serial === "-" ? undefined : serial
}

function matches(device: Device, target: string) {
  return device.name === target || device.serial === target
}

function mergeDevices(active: Device[], emulators: Device[]) {
  const running = new Set(active.flatMap((device) => [device.name, device.serial].filter(Boolean)))
  return [...active, ...emulators.filter((device) => !running.has(device.name) && !running.has(device.serial))]
}

function selectionRequired(devices: Device[]): CliResult {
  if (devices.length === 0) {
    return {
      stdout: "NO_DEVICE_AVAILABLE\nConnect a physical device or create/start an emulator, then retry `devecocli run`.",
      stderr: "",
      exitCode: 1,
    }
  }

  return {
    stdout: [
      "DEVICE_SELECTION_REQUIRED",
      "Available devices:",
      ...devices.map(
        (device) => `- ${device.name}${device.serial ? ` (${device.serial})` : ""} [${device.kind}, ${device.status}]`,
      ),
      "Retry with `devecocli run --device <name-or-serial>`.",
    ].join("\n"),
    stderr: "",
    exitCode: 1,
  }
}

function optionValue(args: string[], option: string) {
  const index = args.indexOf(option)
  if (index >= 0) return args[index + 1]?.trim() || undefined
  return (
    args
      .find((arg) => arg.startsWith(`${option}=`))
      ?.slice(option.length + 1)
      .trim() || undefined
  )
}

function shouldEnhanceRun(args: string[]) {
  return !args.some((arg) => {
    if ([...SPECIAL_RUN_FLAGS].some((flag) => arg === flag || arg.startsWith(`${flag}=`))) return true
    if (!arg.startsWith("-")) return false
    return ![...KNOWN_RUN_FLAGS].some((flag) => arg === flag || arg.startsWith(`${flag}=`))
  })
}

function commandOutput(args: string[], result: CliResult) {
  const output = `${result.stderr}${result.stdout}`.trim()
  return `$ devecocli ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}${output ? `\n${output}` : ""}`
}
