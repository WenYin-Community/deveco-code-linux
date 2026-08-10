import { describe, expect, test } from "bun:test"
import { formatDeviceSelectionPrompt, formatStartAppResults, runStartAppWorkflow } from "../../src/tool/start_app"

type Result = { stdout: string; stderr: string; exitCode: number }

function runner(outputs: Record<string, Partial<Result>>) {
  const calls: string[][] = []
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args)
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        ...outputs[args.join(" ")],
      }
    },
  }
}

const DEVICE_LIST = `Name        Serial          Kind      Device Type
----------  --------------  --------  -----------
HUAWEI Mate 60 Pro  FMR0223  device    phone
API23Phone  127.0.0.1:5555  emulator  phone
`

const EMULATOR_LIST = `Name            Status   Serial          Device Type  OS Version
--------------  -------  --------------  -----------  -------------------------
API23Phone      running  127.0.0.1:5555  phone        HarmonyOS 6.1.1(24) Beta1
Pura 90         stopped  -               phone        HarmonyOS 6.1.1(24) Beta1
Mate X7         stopped  -               foldable     HarmonyOS 6.1.1(24) Beta1
`

describe("start_app workflow", () => {
  test("formats device selection prompt from device and emulator lists", () => {
    const output = formatStartAppResults([
      {
        command: "devecocli device list",
        result: {
          stdout: DEVICE_LIST,
          stderr: "- Querying connected devices…\n",
          exitCode: 0,
        },
      },
      {
        command: "devecocli emulator list",
        result: {
          stdout: EMULATOR_LIST,
          stderr: "- Listing emulators…\n",
          exitCode: 0,
        },
      },
    ])

    expect(output).toContain("请指定要使用的设备。")
    expect(output).toContain("📱 已连接的真机：")
    expect(output).toContain("  - HUAWEI Mate 60 Pro")
    expect(output).toContain("🖥️ 运行中的模拟器：")
    expect(output).toContain("  - API23Phone")
    expect(output).toContain("💤 已安装但未运行的模拟器（选择后将自动启动）：")
    expect(output).toContain("  - Pura 90")
    expect(output).toContain("  - Mate X7")
    expect(output).toContain('hvd="HUAWEI Mate 60 Pro"')
    expect(output).not.toContain("$ devecocli device list")
    expect(output).not.toContain("$ devecocli emulator list")
  })

  test("strips ansi color codes when formatting device selection", () => {
    const output = formatDeviceSelectionPrompt(
      "\u001b[32mName  Serial  Kind  Device Type\u001b[39m\n----  ------  ----  -----------\n\u001b[32mAPI23Phone  127.0.0.1:5555  emulator  phone\u001b[39m\n",
      "",
    )

    expect(output).not.toMatch(/\u001b\[/)
    expect(output).toContain("  - API23Phone")
    expect(output).toContain("🖥️ 运行中的模拟器：")
  })

  test("handles No Active Device without fake hvd guidance", () => {
    const output = formatDeviceSelectionPrompt(
      "- Querying connected devices…\nNo Active Device\n",
      "- Listing emulators…\nNo Active Device\n",
    )

    expect(output).toContain("未检测到可用设备。")
    expect(output).toContain("请先连接真机，或创建/启动模拟器后再重试 start_app。")
    expect(output).toContain("原始输出：")
    expect(output).toContain("No Active Device")
    expect(output).not.toContain("请指定要使用的设备。")
    expect(output).not.toContain("hvd=")
  })

  test("runs directly when the selected device is active", async () => {
    const cli = runner({ "device list": { stdout: "Phone\n" } })
    await runStartAppWorkflow({ hvd: "Phone" }, "C:\\project", cli.run)

    expect(cli.calls).toEqual([
      ["device", "list"],
      ["run", "--skip-build", "--device", "Phone"],
    ])
  })

  test("starts a stopped emulator before running the app", async () => {
    const cli = runner({
      "device list": { stdout: "127.0.0.1:5555\n" },
      "emulator list": { stdout: "Phone Emulator    stopped\n" },
    })
    const results = await runStartAppWorkflow({ hvd: "Phone Emulator" }, "C:\\project", cli.run)

    expect(cli.calls).toEqual([
      ["device", "list"],
      ["emulator", "list"],
      ["emulator", "start", "Phone Emulator"],
      ["run", "--skip-build", "--device", "Phone Emulator"],
    ])
    expect(results[2]?.command).toBe('devecocli emulator start "Phone Emulator"')
    const output = formatStartAppResults(results)
    expect(output).not.toContain("$ devecocli device list")
    expect(output).not.toContain("$ devecocli emulator list")
    expect(output).toContain('$ devecocli emulator start "Phone Emulator"')
    expect(output).toContain('$ devecocli run --skip-build --device "Phone Emulator"')
  })

  test("does not run the app when emulator startup fails", async () => {
    const cli = runner({
      "device list": {
        stdout: `Name  Serial  Kind  Device Type
----  ------  ----  -----------
OtherPhone  127.0.0.1:5555  emulator  phone
`,
      },
      "emulator list": {
        stdout: `Name  Status  Serial  Device Type  OS Version
----  ------  ------  -----------  ----------
TargetPhone  stopped  -  phone  HarmonyOS 6.1.1
`,
      },
      "emulator start TargetPhone": { stderr: "start failed", exitCode: 1 },
    })
    const results = await runStartAppWorkflow({ hvd: "TargetPhone" }, "C:\\project", cli.run)

    expect(cli.calls).toEqual([
      ["device", "list"],
      ["emulator", "list"],
      ["emulator", "start", "TargetPhone"],
    ])
    const output = formatStartAppResults(results)
    expect(output).toContain("请指定要使用的设备。")
    expect(output).toContain("$ devecocli emulator start TargetPhone")
    expect(output).not.toContain("$ devecocli device list")
  })

  test("hides device list after a successful direct run", async () => {
    const cli = runner({ "device list": { stdout: "Phone\n" } })
    const results = await runStartAppWorkflow({ hvd: "Phone" }, "C:\\project", cli.run)

    const output = formatStartAppResults(results)
    expect(output).not.toContain("$ devecocli device list")
    expect(output).toContain("$ devecocli run --skip-build --device Phone")
  })

  test("does not run when the target is not in device or emulator lists", async () => {
    const cli = runner({
      "device list": { stdout: DEVICE_LIST },
      "emulator list": { stdout: EMULATOR_LIST },
    })
    const results = await runStartAppWorkflow({ hvd: "Unknown" }, "C:\\project", cli.run)

    expect(cli.calls).toEqual([
      ["device", "list"],
      ["emulator", "list"],
    ])
    const output = formatStartAppResults(results)
    expect(output).toContain("请指定要使用的设备。")
    expect(output).toContain("📱 已连接的真机：")
    expect(output).not.toContain("$ devecocli device list")
  })
})
