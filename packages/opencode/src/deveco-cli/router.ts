import fs from "fs/promises"
import path from "path"
import stripAnsi from "strip-ansi"
import { Global } from "@opencode-ai/core/global"
import { formatBuildProjectOutput, TRUNCATE_NOTICE } from "@/tool/lib/build-project-output"
import { runBundledDevecoCli } from "@/tool/lib/deveco-cli"
import { findDevEcoHome, hdcPath } from "@/tool/lib/env"

export type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type CliRunner = (args: string[], cwd: string, options?: { skipVersionCheck?: boolean }) => Promise<CliResult>

export type DevecoCliEvent = {
  command: "build" | "create"
  exitCode: number
  durationMs: number
  projectRoot?: string
}

export const DEVECO_CLI_EVENT_FILE = "DEVECO_CODE_CLI_EVENT_FILE"

export const MAX_DOCS_OUTPUT_LENGTH = 5_000

type Device = {
  name: string
  serial?: string
  kind: "physical" | "emulator"
  status: "running" | "stopped"
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
  dependencies: {
    findHome?: () => Promise<string | undefined>
    runCommand?: (cmd: string[]) => Promise<CliResult>
  } = {},
): Promise<CliResult & { fullOutput?: string }> {
  if (args[0] === "log" && args[1] === "clear") {
    return executeLogClear(args.slice(2), cwd, runner, dependencies)
  }
  if (args[0] === "log" && !args.some((arg) => arg === "--help" || arg === "-h")) {
    const invalid = validateLogTail(args.slice(1))
    if (invalid) return invalid
    args = enhanceLogArgs(args)
  }
  if (args[0] === "create" && !args.some((arg) => arg === "--help" || arg === "-h")) {
    const conflict = await createConflict(args.slice(1), cwd)
    if (conflict) return conflict
  }
  if (args[0] === "docs" && (args[1] === "search" || args[1] === "read")) {
    return truncateDocsOutput(await runner(args, cwd))
  }
  if (args[0] === "build" && !args.some((arg) => arg === "--help" || arg === "-h")) {
    return executeBuild(args, cwd, runner)
  }
  if (args[0] === "run" && shouldEnhanceRun(args.slice(1))) {
    return executeRun(args, cwd, runner)
  }
  return runner(args, cwd)
}

function validateLogTail(args: string[]): CliResult | undefined {
  const values = args.flatMap((arg, index) => {
    if (arg === "--tail") return [args[index + 1]]
    if (arg.startsWith("--tail=")) return [arg.slice("--tail=".length)]
    return []
  })
  if (values.length === 0) return
  if (values.every((value) => /^[1-9]\d*$/.test(value ?? "") && Number(value) <= 5_000)) return
  return {
    stdout: "",
    stderr: "`tail` must be an integer between 1 and 5000.\n",
    exitCode: 1,
  }
}

// Default keyword applied when `devecocli log` is called without an explicit
// `--keyword`. App code that instruments debug logs with this prefix is the
// signal this filter captures; without it a bare `log` would dump the whole
// hilog buffer. An explicit `--keyword` (space or `=` form) overrides it.
export const DEFAULT_LOG_KEYWORD = "[DEVECO_DEBUG]"

function hasKeyword(args: string[]) {
  return args.some((arg) => arg === "--keyword" || arg.startsWith("--keyword="))
}

function enhanceLogArgs(args: string[]) {
  if (hasKeyword(args)) return args
  return [...args, "--keyword", DEFAULT_LOG_KEYWORD]
}

async function truncateDocsOutput(result: CliResult) {
  if (result.stdout.length + result.stderr.length <= MAX_DOCS_OUTPUT_LENGTH) return result
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join(result.stdout.endsWith("\n") ? "" : "\n")
  // Keep the complete response available: grep/sed after the CLI only see this preview.
  // Identical responses reuse a path so repeated lookups do not add changing paths to context.
  const file = path.join(
    Global.Path.tmp,
    "devecocli",
    `docs-${new Bun.CryptoHasher("sha256").update(output).digest("hex")}.txt`,
  )
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, output)
  const notice = `[Documentation output truncated to ${MAX_DOCS_OUTPUT_LENGTH} characters.]\nFull output saved to: ${file}\nSearch the saved file with Grep, or use Read with offset/limit. Do not pipe this preview to grep/sed to search the full document.\n\n`
  const truncated = `${notice}${output.slice(0, MAX_DOCS_OUTPUT_LENGTH - notice.length - 1)}\n`
  if (!result.stdout) return { ...result, stderr: truncated }
  return { ...result, stdout: truncated, stderr: "" }
}

export async function runDevecoCliProxy(args: string[], cwd: string) {
  const started = Date.now()
  const result = await executeDevecoCliProxy(args, cwd)
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
  dependencies: {
    findHome?: () => Promise<string | undefined>
    runCommand?: (cmd: string[]) => Promise<CliResult>
  },
): Promise<CliResult> {
  const target = optionValue(args, "--device")
  const valid =
    args.length === 0 ||
    (target &&
      !target.startsWith("-") &&
      ((args.length === 2 && args[0] === "--device") || (args.length === 1 && args[0].startsWith("--device="))))
  if (!valid) {
    return {
      stdout: "",
      stderr: "Usage: devecocli log clear [--device <name-or-serial>]\n",
      exitCode: 1,
    }
  }

  const home = await (dependencies.findHome ?? findDevEcoHome)()
  if (!home) {
    return {
      stdout: "",
      stderr: "DevEco Studio path not found. Set DEVECO_HOME and retry.\n",
      exitCode: 1,
    }
  }
  const hdc = hdcPath(home)
  if (!(await Bun.file(hdc).exists())) {
    return { stdout: "", stderr: `hdc not found: ${hdc}\n`, exitCode: 1 }
  }

  const discovery = await runner(["device", "list", "--format", "json"], cwd, { skipVersionCheck: true })
  if (discovery.exitCode !== 0) return discovery
  const devices = parseDevices(discovery.stdout)
  if (!devices) {
    return { stdout: "", stderr: "Unable to parse connected devices. No logs were cleared.\n", exitCode: 1 }
  }
  // Prefer an exact serial over a display name, and never clear an ambiguous/default target.
  const candidates = !target
    ? devices
    : devices.some((device) => device.serial === target)
      ? devices.filter((device) => device.serial === target)
      : devices.filter((device) => device.name === target)
  if (candidates.length !== 1) {
    return {
      stdout: "",
      stderr: `${[
        candidates.length > 1 ? "DEVICE_SELECTION_REQUIRED" : target ? "DEVICE_NOT_FOUND" : "NO_DEVICE_AVAILABLE",
        "No logs were cleared. Connect a device and select a unique serial.",
        ...devices.map((device) => `- ${device.name}${device.serial ? ` (${device.serial})` : ""}`),
        "Retry with `devecocli log clear --device <serial>`.",
      ].join("\n")}\n`,
      exitCode: 1,
    }
  }
  const device = candidates[0]
  if (!device.serial) {
    return {
      stdout: "",
      stderr: "DEVICE_SERIAL_UNAVAILABLE\nNo logs were cleared. Refresh the device list and retry.\n",
      exitCode: 1,
    }
  }
  const result = await (dependencies.runCommand ?? runCommand)([hdc, "-t", device.serial, "shell", "hilog", "-r"])
  if (result.exitCode !== 0) return result
  // HDC can report transport failures in stdout while exiting successfully.
  if (/\[(?:fail|error)\]|\bfail(?:ed|ure)?\b|^\s*error\b/im.test(stripAnsi(`${result.stdout}\n${result.stderr}`))) {
    return { ...result, exitCode: 1 }
  }
  return {
    stdout: `Device log buffer cleared.\ndevice: ${device.name} (${device.serial})\n`,
    stderr: result.stderr,
    exitCode: 0,
  }
}

async function createConflict(args: string[], cwd: string): Promise<CliResult | undefined> {
  const appName = optionValue(args, "--app-name")
  if (!appName) return
  const target = path.resolve(cwd, optionValue(args, "--project-path") ?? appName)
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat?.isDirectory()) return
  if ((await fs.readdir(target)).length === 0) return
  return {
    stdout: "",
    stderr: `${JSON.stringify({
      code: "PROJECT_EXISTS",
      message: `Target "${target}" already exists and is not empty.`,
      hint: "Ask the user whether to overwrite, rename, or cancel. Never overwrite without explicit confirmation.",
      details: { targetRoot: target },
    }, null, 2)}\n`,
    exitCode: 2,
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
  if (!file || (args[0] !== "build" && args[0] !== "create")) return
  const projectRoot = args[0] === "create" && result.exitCode === 0 ? readProjectRoot(result.stdout) : undefined
  const event: DevecoCliEvent = {
    command: args[0],
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

async function executeRun(args: string[], cwd: string, runner: CliRunner): Promise<CliResult> {
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
    return startEmulatorAndRun(device, runArgs, cwd, runner)
  }

  const emulator = emulators.find((device) => matches(device, target))
  if (!emulator) return runner(args, cwd)
  if (emulator.status === "running") return runner(args, cwd)

  return startEmulatorAndRun(emulator, args, cwd, runner)
}

async function startEmulatorAndRun(device: Device, args: string[], cwd: string, runner: CliRunner) {
  const start = await runner(["emulator", "start", device.name], cwd, { skipVersionCheck: true })
  if (start.exitCode !== 0) {
    return { stdout: commandOutput(["emulator", "start", device.name], start), stderr: "", exitCode: start.exitCode }
  }
  const run = await runner(args, cwd)
  return {
    stdout: [commandOutput(["emulator", "start", device.name], start), commandOutput(args, run)]
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
    if (!text.startsWith("[") || end < 0) return
    const value: unknown = JSON.parse(text.slice(0, end + 1))
    if (!Array.isArray(value)) return
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
  } catch {
    return
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
