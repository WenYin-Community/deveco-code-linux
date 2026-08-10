/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from "path"
import stripAnsi from "strip-ansi"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { getSessionCwd } from "./lib/session-cwd"
import {
  buildDevecoCliRunArgs,
  buildDevecoCliStartAppCommands,
  devecoCliListContainsTarget,
  runBundledDevecoCli,
} from "./lib/deveco-cli"

const Parameters = Schema.Struct({
  ability: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: "要启动的 Ability 名称（如 'EntryAbility'）。如果不指定，则由 devecocli 从 module.json5 中读取。",
  }),
  hvd: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: "目标设备的名称或序列号（例如 127.0.0.1:5555）。如果不提供，系统将列出所有可用设备供选择。",
  }),
  module: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: "要启动的模块名称（如 'entry'）。如果不指定，则由 devecocli 自动选择唯一可运行模块。",
  }),
  target: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: "构建目标（如 'default'）。指定后将与模块组合为 module@target。",
  }),
})

type CliResult = Awaited<ReturnType<typeof runBundledDevecoCli>>
type StartAppInput = Schema.Schema.Type<typeof Parameters>
type CliRunner = (args: string[], cwd: string) => Promise<CliResult>
export type RecordedResult = { command: string; result: CliResult }

interface StartAppMetadata {
  commands: string[]
  exitCodes: number[]
}

function resolveProjectRoot(sessionID: string | undefined, fallback: string) {
  const sessionDir = sessionID ? getSessionCwd(sessionID) : undefined
  return path.resolve(sessionDir ?? fallback)
}

function resultOutput(result: CliResult) {
  const stdout = stripAnsi(result.stdout)
  const stderr = stripAnsi(result.stderr)
  if (stdout && stderr) return `${stderr}${stdout}`
  return stdout || stderr
}

function commandText(args: string[]) {
  return `devecocli ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`
}

const DISCOVERY_COMMANDS = new Set(["devecocli device list", "devecocli emulator list"])

type CliTableRow = Record<string, string>

/** Parse an aligned CLI table by header names (Name / Kind / Status / ...). */
function parseCliTable(text: string): CliTableRow[] {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  // Require Name plus Kind/Status/Serial so progress lines are less likely to match.
  const headerIdx = lines.findIndex(
    (line) => /^\s*Name\b/i.test(line) && /\b(Kind|Status|Serial)\b/i.test(line),
  )
  if (headerIdx < 0) return []

  const headers = lines[headerIdx]
    .trim()
    .split(/\s{2,}/)
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean)
  if (!headers.includes("name")) return []

  const rows: CliTableRow[] = []
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (/^-+(\s+-+)*$/.test(line)) continue
    const cells = line.split(/\s{2,}/).map((cell) => cell.trim())
    if (cells.length < 2) continue

    const row: CliTableRow = {}
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = cells[c] ?? ""
    }
    if (row.name) rows.push(row)
  }
  return rows
}

function cell(row: CliTableRow, key: string) {
  return (row[key] ?? "").trim()
}

function formatRawDiscovery(deviceListOutput: string, emulatorListOutput: string) {
  const blocks: string[] = []
  const device = stripAnsi(deviceListOutput).trim()
  const emulator = stripAnsi(emulatorListOutput).trim()
  if (device) blocks.push(`$ devecocli device list\n${device}`)
  if (emulator) blocks.push(`$ devecocli emulator list\n${emulator}`)
  return blocks.join("\n\n")
}

export function formatDeviceSelectionPrompt(deviceListOutput: string, emulatorListOutput: string): string {
  const physical: string[] = []
  const running = new Set<string>()
  const stopped: string[] = []

  for (const row of parseCliTable(deviceListOutput)) {
    const name = cell(row, "name")
    const kind = cell(row, "kind").toLowerCase()
    if (!name) continue
    if (kind === "emulator") running.add(name)
    else physical.push(name)
  }

  for (const row of parseCliTable(emulatorListOutput)) {
    const name = cell(row, "name")
    const status = cell(row, "status").toLowerCase()
    if (!name) continue
    if (status === "running" || status === "started") running.add(name)
    else if (status === "stopped" || status === "offline") stopped.push(name)
  }

  const stoppedOnly = stopped.filter((name) => !running.has(name))
  if (physical.length === 0 && running.size === 0 && stoppedOnly.length === 0) {
    const raw = formatRawDiscovery(deviceListOutput, emulatorListOutput)
    return [
      "未检测到可用设备。",
      "",
      "请先连接真机，或创建/启动模拟器后再重试 start_app。",
      ...(raw ? ["", "原始输出：", raw] : []),
    ].join("\n")
  }

  const lines = ["请指定要使用的设备。", "当前可用设备列表：", ""]

  if (physical.length > 0) {
    lines.push("📱 已连接的真机：")
    for (const name of physical) lines.push(`  - ${name}`)
    lines.push("")
  }
  if (running.size > 0) {
    lines.push("🖥️ 运行中的模拟器：")
    for (const name of running) lines.push(`  - ${name}`)
    lines.push("")
  }
  if (stoppedOnly.length > 0) {
    lines.push("💤 已安装但未运行的模拟器（选择后将自动启动）：")
    for (const name of stoppedOnly) lines.push(`  - ${name}`)
    lines.push("")
  }

  const example = physical[0] ?? [...running][0] ?? stoppedOnly[0]!
  lines.push("请使用 hvd 参数指定设备名称，例如：")
  lines.push(`- hvd="${example}"`)
  return lines.join("\n")
}

function formatCommandResult(command: string, result: CliResult) {
  return `$ ${command}\n${resultOutput(result)}`.trimEnd()
}

export function formatStartAppResults(results: RecordedResult[]) {
  const appStarted = results.some(
    ({ command, result }) => command.startsWith("devecocli run ") && result.exitCode === 0,
  )
  if (appStarted) {
    return results
      .filter(({ command }) => !DISCOVERY_COMMANDS.has(command))
      .map(({ command, result }) => formatCommandResult(command, result))
      .join("\n\n")
  }

  const deviceList = results.find(({ command }) => command === "devecocli device list")
  const emulatorList = results.find(({ command }) => command === "devecocli emulator list")
  const others = results.filter(({ command }) => !DISCOVERY_COMMANDS.has(command))

  if (deviceList || emulatorList) {
    const prompt = formatDeviceSelectionPrompt(
      deviceList ? resultOutput(deviceList.result) : "",
      emulatorList ? resultOutput(emulatorList.result) : "",
    )
    if (others.length === 0) return prompt
    return [prompt, ...others.map(({ command, result }) => formatCommandResult(command, result))].join("\n\n")
  }

  return results.map(({ command, result }) => formatCommandResult(command, result)).join("\n\n")
}

export async function runStartAppWorkflow(
  args: StartAppInput,
  cwd: string,
  runner: CliRunner = runBundledDevecoCli,
): Promise<RecordedResult[]> {
  const results: RecordedResult[] = []
  const invoke = async (cliArgs: string[]) => {
    const result = await runner(cliArgs, cwd)
    results.push({ command: commandText(cliArgs), result })
    return result
  }

  for (const cliArgs of buildDevecoCliStartAppCommands(args)) {
    await invoke(cliArgs)
  }

  const device = args.hvd?.trim()
  if (!device) return results

  const runArgs = buildDevecoCliRunArgs({
    device,
    ability: args.ability ?? undefined,
    module: args.module ?? undefined,
    target: args.target ?? undefined,
  })
  const deviceList = results[0]?.result
  if (deviceList && devecoCliListContainsTarget(resultOutput(deviceList), device)) {
    await invoke(runArgs)
    return results
  }

  const emulatorList = await invoke(["emulator", "list"])
  if (!devecoCliListContainsTarget(resultOutput(emulatorList), device)) {
    return results
  }

  const startResult = await invoke(["emulator", "start", device])
  if (startResult.exitCode === 0) {
    await invoke(runArgs)
  }
  return results
}

export const StartAppTool = Tool.define("start_app", Effect.gen(function* () {
  return {
    description:
      "Run the app on a specified emulator or physical device (does not build). When no device is specified, returns a selectable device list including connected physical devices, running emulators, and installed but stopped emulators; selecting a stopped emulator starts it automatically.",
    parameters: Parameters,
    execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<StartAppMetadata>) =>
      Effect.gen(function* () {
        const cwd = resolveProjectRoot(ctx.sessionID, process.cwd())
        const results = yield* Effect.tryPromise(() => runStartAppWorkflow(args, cwd))

        const commands = results.map(({ command }) => command)
        return {
          title: commands.join(" && "),
          output: formatStartAppResults(results),
          metadata: {
            commands,
            exitCodes: results.map(({ result }) => result.exitCode),
          },
        }
      }).pipe(Effect.orDie),
  }
}))
