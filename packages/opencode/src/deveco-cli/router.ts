import fs from "fs/promises"
import path from "path"
import stripAnsi from "strip-ansi"
import { Global } from "@opencode-ai/core/global"
import { formatBuildProjectOutput, TRUNCATE_NOTICE } from "@/tool/lib/build-project-output"
import { runBundledDevecoCli } from "@/tool/lib/deveco-cli"

export type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type CliRunner = (args: string[], cwd: string, options?: { skipVersionCheck?: boolean }) => Promise<CliResult>

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
const DOCS_TRUNCATE_NOTICE = `\n\n[Documentation output truncated to ${MAX_DOCS_OUTPUT_LENGTH} characters.]\n`

export async function executeDevecoCliProxy(
  args: string[],
  cwd: string,
  runner: CliRunner = runBundledDevecoCli,
): Promise<CliResult & { fullOutput?: string }> {
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

function truncateDocsOutput(result: CliResult) {
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .map((text) => (text.endsWith("\n") ? text : `${text}\n`))
    .join("")
  if (output.length <= MAX_DOCS_OUTPUT_LENGTH) return result
  const truncated = `${output.slice(0, MAX_DOCS_OUTPUT_LENGTH - DOCS_TRUNCATE_NOTICE.length)}${DOCS_TRUNCATE_NOTICE}`
  if (!result.stdout) return { ...result, stderr: truncated }
  return { ...result, stdout: truncated, stderr: "" }
}

export async function runDevecoCliProxy(args: string[], cwd: string) {
  const result = await executeDevecoCliProxy(args, cwd)
  const output = result.fullOutput ? await persistFullOutput(result) : result.stdout
  if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`)
  if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`)
  return result.exitCode
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
  if (emulatorList.exitCode !== 0) return target ? runner(args, cwd) : selectionRequired(active)

  const emulators = parseEmulators(emulatorList.stdout)
  if (!emulators) return runner(args, cwd)
  if (!target) return selectionRequired(mergeDevices(active, emulators))

  const emulator = emulators.find((device) => matches(device, target))
  if (!emulator) return runner(args, cwd)
  if (emulator.status === "running") return runner(args, cwd)

  const start = await runner(["emulator", "start", emulator.name], cwd, { skipVersionCheck: true })
  if (start.exitCode !== 0) {
    return { stdout: commandOutput(["emulator", "start", emulator.name], start), stderr: "", exitCode: start.exitCode }
  }
  const run = await runner(args, cwd)
  return {
    stdout: [commandOutput(["emulator", "start", emulator.name], start), commandOutput(args, run)]
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
