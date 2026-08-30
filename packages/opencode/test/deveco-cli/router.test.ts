import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { executeDevecoCliProxy, type CliResult } from "../../src/deveco-cli/router"
import { hdcPath } from "../../src/tool/lib/env"
import { tmpdir } from "../fixture/fixture"

function runner(outputs: Record<string, Partial<CliResult>>) {
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

function optionValue(args: string[], option: string) {
  const index = args.indexOf(option)
  if (index >= 0) return args[index + 1]
  return args.find((arg) => arg.startsWith(`${option}=`))?.slice(option.length + 1)
}

const DEVICES = JSON.stringify([
  { name: "Mate 60", serial: "FMR0223", kind: "device", deviceType: "phone" },
  { name: "Phone", serial: "127.0.0.1:5555", kind: "emulator", deviceType: "phone" },
])

const EMULATORS = JSON.stringify([
  { name: "Phone", status: "running", serial: "127.0.0.1:5555", deviceType: "phone" },
  { name: "Pura 90", status: "stopped", serial: "-", deviceType: "phone" },
])
const UPDATE_NOTICE = "New version 1.3.0 available, run `devecocli update` to upgrade"

describe("devecocli proxy router", () => {
  test("passes unrelated commands through unchanged", async () => {
    const cli = runner({ "device list": { stdout: "raw" } })
    const result = await executeDevecoCliProxy(["device", "list"], "C:\\project", cli.run)

    expect(cli.calls).toEqual([["device", "list"]])
    expect(result.stdout).toBe("raw")
  })

  test("intercepts docs search and forwards its arguments unchanged", async () => {
    const args = ["docs", "search", "@State", "lifecycle", "--format", "json"]
    const cli = runner({ "docs search @State lifecycle --format json": { stdout: "[]" } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout).toBe("[]")
  })

  test("intercepts docs read and forwards its document ID unchanged", async () => {
    const args = ["docs", "read", "guides/application model"]
    const cli = runner({ "docs read guides/application model": { stdout: "content" } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout).toBe("content")
  })

  test("keeps search results beyond the 5000 character preview in the saved file", async () => {
    const args = ["docs", "search", "@State", "--limit", "10"]
    const output = `${"Earlier search result\n".repeat(300)}guides/late-result\n  Title: Final search result\n`
    const cli = runner({ "docs search @State --limit 10": { stdout: output } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout.length + result.stderr.length).toBe(5_000)
    expect(result.stdout).toStartWith("[Documentation output truncated to 5000 characters.]\nFull output saved to: ")
    expect(result.stdout).not.toContain("guides/late-result")
    const file = result.stdout.match(/^Full output saved to: (.+)$/m)?.[1]
    expect(file).toBeDefined()
    expect(await Bun.file(file!).text()).toBe(output)
    expect(result.exitCode).toBe(0)
  })

  test("preserves docs output at the 5000 character boundary without a trailing newline", async () => {
    const args = ["docs", "read", "document-id"]
    const output = "x".repeat(5_000)
    const cli = runner({ "docs read document-id": { stdout: output } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout).toBe(output)
  })

  test("keeps API definitions beyond the docs read preview recoverable without another CLI call", async () => {
    const output = `${"文档介绍\n".repeat(1_100)}\n## onDateAccept\nonDateAccept(value: Date): void\n`
    const cli = runner({ "docs read date-picker": { stdout: output } })
    const result = await executeDevecoCliProxy(["docs", "read", "date-picker"], "C:\\project", cli.run)

    expect(result.stdout.length).toBe(5_000)
    expect(result.stdout).not.toContain("onDateAccept")
    expect(result.stdout).toContain("Read with offset/limit")
    const file = result.stdout.match(/^Full output saved to: (.+)$/m)?.[1]
    expect(file).toBeDefined()
    const content = await Bun.file(file!).text()
    expect(content).toBe(output)
    expect(content.split("\n").find((line) => line.startsWith("onDateAccept("))).toBe("onDateAccept(value: Date): void")
    expect(cli.calls).toEqual([["docs", "read", "date-picker"]])

    const repeated = await executeDevecoCliProxy(["docs", "read", "date-picker"], "C:\\project", cli.run)
    expect(repeated.stdout).toBe(result.stdout)
  })

  test("truncates combined docs stdout and stderr to 5000 characters", async () => {
    const args = ["docs", "read", "document-id"]
    const cli = runner({ "docs read document-id": { stdout: "x".repeat(4_000), stderr: "y".repeat(2_000) } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout.length + result.stderr.length).toBe(5_000)
    expect(result.stdout).toStartWith("[Documentation output truncated to 5000 characters.]\n")
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    const file = result.stdout.match(/^Full output saved to: (.+)$/m)?.[1]
    expect(file).toBeDefined()
    expect(await Bun.file(file!).text()).toBe(`${"x".repeat(4_000)}\n${"y".repeat(2_000)}`)
  })

  test("preserves the exit code and recovers truncated stderr-only docs failures", async () => {
    const output = `${"Documentation service error\n".repeat(300)}Final error detail\n`
    const cli = runner({ "docs read broken": { stderr: output, exitCode: 2 } })
    const result = await executeDevecoCliProxy(["docs", "read", "broken"], "C:\\project", cli.run)

    expect(result.stdout).toBe("")
    expect(result.stderr.length).toBe(5_000)
    expect(result.exitCode).toBe(2)
    const file = result.stderr.match(/^Full output saved to: (.+)$/m)?.[1]
    expect(file).toBeDefined()
    expect(await Bun.file(file!).text()).toBe(output)
  })

  test("formats build output and preserves the real exit code", async () => {
    const cli = runner({ build: { stderr: "ArkTS error", exitCode: 1 } })
    const result = await executeDevecoCliProxy(["build"], "C:\\project", cli.run)

    expect(cli.calls).toEqual([["build"]])
    expect(result.stdout).toContain("ArkTS error")
    expect(result.stdout).toContain("BUILD FAILED (exitCode=1)")
    expect(result.exitCode).toBe(1)
  })

  test("returns device choices when run omits --device", async () => {
    const cli = runner({
      "device list --format json": { stdout: `${DEVICES}\n\n${UPDATE_NOTICE}` },
      "emulator list --format json": { stdout: `${EMULATORS}\n\n${UPDATE_NOTICE}` },
    })
    const result = await executeDevecoCliProxy(["run", "--skip-build"], "C:\\project", cli.run)

    expect(cli.calls).toEqual([
      ["device", "list", "--format", "json"],
      ["emulator", "list", "--format", "json"],
    ])
    expect(result.stdout).toContain("DEVICE_SELECTION_REQUIRED")
    expect(result.stdout).toContain("Mate 60 (FMR0223) [physical, running]")
    expect(result.stdout).toContain("Pura 90 [emulator, stopped]")
    expect(result.exitCode).toBe(1)
  })

  test("runs directly when the selected device is active", async () => {
    const cli = runner({
      "device list --format json": { stdout: DEVICES },
      "run --skip-build --device Mate 60": { stdout: "started" },
    })
    const args = ["run", "--skip-build", "--device", "Mate 60"]
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([["device", "list", "--format", "json"], args])
    expect(result.stdout).toBe("started")
  })

  test("auto-selects the only available device", async () => {
    const cli = runner({
      "device list --format json": { stdout: JSON.stringify([{ name: "Mate 60", serial: "FMR0223", kind: "device" }]) },
      "emulator list --format json": { stdout: "[]" },
      "run --skip-build --device FMR0223": { stdout: "started" },
    })
    const result = await executeDevecoCliProxy(["run", "--skip-build"], "C:\\project", cli.run)

    expect(cli.calls).toEqual([
      ["device", "list", "--format", "json"],
      ["emulator", "list", "--format", "json"],
      ["run", "--skip-build", "--device", "FMR0223"],
    ])
    expect(result.stdout).toBe("started")
  })

  test("starts and selects the only stopped emulator", async () => {
    const cli = runner({
      "device list --format json": { stdout: "[]" },
      "emulator list --format json": { stdout: JSON.stringify([{ name: "Pura 90", status: "stopped", serial: "-" }]) },
      "emulator start Pura 90": { stdout: "emulator started" },
      "run --skip-build --device Pura 90": { stdout: "app started" },
    })
    const result = await executeDevecoCliProxy(["run", "--skip-build"], "C:\\project", cli.run)

    expect(cli.calls.at(-1)).toEqual(["run", "--skip-build", "--device", "Pura 90"])
    expect(result.stdout).toContain("app started")
  })

  test("starts a stopped emulator before preserving the original run arguments", async () => {
    const cli = runner({
      "device list --format json": { stdout: DEVICES },
      "emulator list --format json": { stdout: EMULATORS },
      "emulator start Pura 90": { stdout: "emulator started" },
      "run --skip-build --device Pura 90 --module entry --uninstall": { stdout: "app started" },
    })
    const args = ["run", "--skip-build", "--device", "Pura 90", "--module", "entry", "--uninstall"]
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([
      ["device", "list", "--format", "json"],
      ["emulator", "list", "--format", "json"],
      ["emulator", "start", "Pura 90"],
      args,
    ])
    expect(result.stdout).toContain('$ devecocli emulator start "Pura 90"')
    expect(result.stdout).toContain('$ devecocli run --skip-build --device "Pura 90" --module entry --uninstall')
    expect(result.stdout).toContain("app started")
  })

  test("passes special run modes through without device discovery", async () => {
    const args = ["run", "--hotreload", "--module", "entry"]
    const cli = runner({ "run --hotreload --module entry": { stdout: "hot reload" } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout).toBe("hot reload")
  })

  test("passes unknown run options through for forward compatibility", async () => {
    const args = ["run", "--future-mode"]
    const cli = runner({ "run --future-mode": { stdout: "future" } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout).toBe("future")
  })

  test("falls back to the real run command when discovery JSON changes", async () => {
    const args = ["run", "--skip-build", "--device=Phone"]
    const cli = runner({
      "device list --format json": { stdout: "not-json" },
      "run --skip-build --device=Phone": { stdout: "native fallback" },
    })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([["device", "list", "--format", "json"], args])
    expect(result.stdout).toBe("native fallback")
  })

  test("falls back to the real run command when emulator discovery fails", async () => {
    const args = ["run", "--skip-build"]
    const cli = runner({
      "device list --format json": { stdout: "[]" },
      "emulator list --format json": { stderr: "discovery failed", exitCode: 1 },
      "run --skip-build": { stdout: "native fallback" },
    })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls.at(-1)).toEqual(args)
    expect(result.stdout).toBe("native fallback")
  })

  test("returns PROJECT_EXISTS without invoking create for a non-empty explicit target", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "Project With Spaces")
    await fs.mkdir(target)
    await Bun.write(path.join(target, "existing.txt"), "keep")
    const args = ["create", `--project-path=${target}`, "--app-name", "Demo"]
    const cli = runner({})
    const result = await executeDevecoCliProxy(args, tmp.path, cli.run)

    expect(cli.calls).toEqual([])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('"code": "PROJECT_EXISTS"')
    expect(result.stderr).toContain(target)
  })

  test("uses cwd/app-name for create conflict checks when project path is omitted", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "Demo"))
    await Bun.write(path.join(tmp.path, "Demo", "existing.txt"), "keep")
    const cli = runner({})
    const result = await executeDevecoCliProxy(["create", "--app-name", "Demo"], tmp.path, cli.run)

    expect(cli.calls).toEqual([])
    expect(result.exitCode).toBe(2)
  })

  test("stages create beside an empty target directory before promoting it", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "Demo")
    await fs.mkdir(target)
    const args = ["create", "--project-path", target, "--app-name", "Demo"]
    const cli = runner({})
    const result = await executeDevecoCliProxy(args, tmp.path, cli.run)

    expect(cli.calls).toHaveLength(1)
    const staging = optionValue(cli.calls[0], "--project-path")
    expect(staging).toStartWith(path.join(tmp.path, ".Demo.deveco-create-"))
    expect(staging).not.toBe(target)
    expect(await fs.readdir(target)).toEqual([])
    expect(await fs.readdir(tmp.path)).toEqual(["Demo"])
    expect(result.exitCode).toBe(0)
  })

  test("atomically promotes a staged project with missing parent directories", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "workspace", "apps", "Demo")
    const run = async (args: string[]) => {
      const staging = optionValue(args, "--project-path")!
      await fs.mkdir(staging, { recursive: true })
      await Bun.write(path.join(staging, "build-profile.json5"), "generated")
      return { stdout: `Project root: ${staging}\n`, stderr: "", exitCode: 0 }
    }

    const result = await executeDevecoCliProxy(
      ["create", "--project-path", target, "--app-name", "Demo"],
      tmp.path,
      run,
    )

    expect(await Bun.file(path.join(target, "build-profile.json5")).text()).toBe("generated")
    expect(await fs.readdir(tmp.path)).toEqual(["workspace"])
    expect(result.stdout).toBe(`Project root: ${target}\n`)
  })

  test("merges a generated project into a non-empty target without changing existing content", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "Demo")
    await fs.mkdir(path.join(target, ".spec"), { recursive: true })
    await Bun.write(path.join(target, ".spec", "sdd.md"), "design")
    const calls: string[][] = []
    const run = async (args: string[]) => {
      calls.push(args)
      const staging = optionValue(args, "--project-path")!
      await fs.mkdir(path.join(staging, "entry"), { recursive: true })
      await Bun.write(path.join(staging, "build-profile.json5"), "generated")
      await Bun.write(path.join(staging, "entry", "oh-package.json5"), "generated")
      return { stdout: `Project root: ${staging}\n`, stderr: "", exitCode: 0 }
    }

    const result = await executeDevecoCliProxy(
      ["create", "--project-path", target, "--app-name", "Demo", "--merge"],
      tmp.path,
      run,
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain("--merge")
    expect(optionValue(calls[0], "--project-path")).toStartWith(path.join(tmp.path, ".Demo.deveco-create-"))
    expect(await Bun.file(path.join(target, ".spec", "sdd.md")).text()).toBe("design")
    expect(await Bun.file(path.join(target, "build-profile.json5")).text()).toBe("generated")
    expect(await Bun.file(path.join(target, "entry", "oh-package.json5")).text()).toBe("generated")
    expect(await fs.readdir(tmp.path)).toEqual(["Demo"])
    expect(result.stdout).toContain(`Project root: ${target}`)
    expect(result.stdout).toContain(`Preserved existing content in: ${target}`)
    expect(result.exitCode).toBe(0)
  })

  test("reports all create merge conflicts before changing the target", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "Demo")
    await fs.mkdir(target)
    await Bun.write(path.join(target, "build-profile.json5"), "existing")
    const run = async (args: string[]) => {
      const staging = optionValue(args, "--project-path")!
      await Bun.write(path.join(staging, "build-profile.json5"), "generated")
      await Bun.write(path.join(staging, "new-file.txt"), "generated")
      return { stdout: `Project root: ${staging}\n`, stderr: "", exitCode: 0 }
    }

    const result = await executeDevecoCliProxy(
      ["create", "--project-path", target, "--app-name", "Demo", "--merge"],
      tmp.path,
      run,
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('"code": "PROJECT_FILE_CONFLICT"')
    expect(result.stderr).toContain('"build-profile.json5"')
    expect(await Bun.file(path.join(target, "build-profile.json5")).text()).toBe("existing")
    expect(await Bun.file(path.join(target, "new-file.txt")).exists()).toBe(false)
    expect(await fs.readdir(tmp.path)).toEqual(["Demo"])
  })

  test("cleans create staging when project generation fails", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "Demo")
    const run = async (args: string[]) => {
      const staging = optionValue(args, "--project-path")!
      await Bun.write(path.join(staging, "partial.txt"), "partial")
      return { stdout: "", stderr: `Failed in ${staging}\n`, exitCode: 1 }
    }

    const result = await executeDevecoCliProxy(
      ["create", "--project-path", target, "--app-name", "Demo"],
      tmp.path,
      run,
    )

    expect(result.stderr).toBe(`Failed in ${target}\n`)
    expect(await Bun.file(target).exists()).toBe(false)
    expect(await fs.readdir(tmp.path)).toEqual([])
  })

  test("adds the proxy merge option to create help", async () => {
    const cli = runner({ "create --help": { stdout: "Usage: devecocli create [options]\n" } })
    const result = await executeDevecoCliProxy(["create", "--merge", "--help"], "/project", cli.run)

    expect(cli.calls).toEqual([["create", "--help"]])
    expect(result.stdout).toContain("--merge")
    expect(result.stdout).toContain("fail on generated file conflicts")
  })

  test("accepts log tail values from 1 through 5000", async () => {
    const lower = ["log", "--tail", "1", "--keyword", "DEBUG"]
    const upper = ["log", "--tail=5000"]
    const upperEnhanced = [...upper, "--keyword", "[DEVECO_DEBUG]"]
    const cli = runner({
      [lower.join(" ")]: { stdout: "lower" },
      [upperEnhanced.join(" ")]: { stdout: "upper" },
    })

    expect((await executeDevecoCliProxy(lower, "C:\\project", cli.run)).stdout).toBe("lower")
    expect((await executeDevecoCliProxy(upper, "C:\\project", cli.run)).stdout).toBe("upper")
    expect(cli.calls).toEqual([lower, upperEnhanced])
  })

  test("injects the default DEVECO_DEBUG keyword when none is given", async () => {
    const args = ["log", "--device", "Phone"]
    const enhanced = [...args, "--keyword", "[DEVECO_DEBUG]"]
    const cli = runner({ [enhanced.join(" ")]: { stdout: "logs" } })

    expect((await executeDevecoCliProxy(args, "C:\\project", cli.run)).stdout).toBe("logs")
    expect(cli.calls).toEqual([enhanced])
  })

  test("does not override an explicit --keyword= form", async () => {
    const args = ["log", "--keyword=CRASH"]
    const cli = runner({ [args.join(" ")]: { stdout: "crash" } })

    expect((await executeDevecoCliProxy(args, "C:\\project", cli.run)).stdout).toBe("crash")
    expect(cli.calls).toEqual([args])
  })

  test("rejects invalid log tail values before invoking the CLI", async () => {
    const cli = runner({})
    const invalid = [
      ["log", "--tail", "0"],
      ["log", "--tail", "5001"],
      ["log", "--tail=1.5"],
      ["log", "--tail"],
      ["log", "--tail=5000", "--tail", "5001"],
    ]

    for (const args of invalid) {
      const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("between 1 and 5000")
    }
    expect(cli.calls).toEqual([])
  })

  test("passes log help through without tail validation", async () => {
    const args = ["log", "--help", "--tail", "5001"]
    const cli = runner({ [args.join(" ")]: { stdout: "help" } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout).toBe("help")
  })

  test("resolves device names and serials before clearing logs", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.dirname(hdcPath(tmp.path)), { recursive: true })
    await Bun.write(hdcPath(tmp.path), "hdc")
    const commands: string[][] = []
    const dependencies = {
      findHome: async () => tmp.path,
      runCommand: async (cmd: string[]) => {
        commands.push(cmd)
        return { stdout: "", stderr: "", exitCode: 0 }
      },
    }

    const cli = runner({ "device list --format json": { stdout: DEVICES } })
    for (const args of [["--device=Phone"], ["--device", "127.0.0.1:5555"], ["--device", "Mate 60"]]) {
      const result = await executeDevecoCliProxy(["log", "clear", ...args], tmp.path, cli.run, dependencies)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Device log buffer cleared.")
    }
    expect(commands).toEqual([
      [hdcPath(tmp.path), "-t", "127.0.0.1:5555", "shell", "hilog", "-r"],
      [hdcPath(tmp.path), "-t", "127.0.0.1:5555", "shell", "hilog", "-r"],
      [hdcPath(tmp.path), "-t", "FMR0223", "shell", "hilog", "-r"],
    ])
    expect(cli.calls).toEqual(Array.from({ length: 3 }, () => ["device", "list", "--format", "json"]))
  })

  test("pins the only connected device when clearing logs without a selector", async () => {
    await using tmp = await tmpdir()
    await Bun.write(hdcPath(tmp.path), "hdc")
    const cli = runner({
      "device list --format json": { stdout: '[{"name":"Pura 90 Pro","serial":"127.0.0.1:5555"}]' },
    })
    const commands: string[][] = []
    const result = await executeDevecoCliProxy(["log", "clear"], tmp.path, cli.run, {
      findHome: async () => tmp.path,
      runCommand: async (cmd) => {
        commands.push(cmd)
        return { stdout: "Log buffer cleared successfully\n", stderr: "", exitCode: 0 }
      },
    })

    expect(commands).toEqual([[hdcPath(tmp.path), "-t", "127.0.0.1:5555", "shell", "hilog", "-r"]])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("127.0.0.1:5555")
  })

  test("rejects empty, missing, repeated or unsupported log clear arguments before discovery", async () => {
    const cli = runner({})
    const invalid = [
      ["--device="],
      ["--device=   "],
      ["--device"],
      ["--device", ""],
      ["--device", "   "],
      ["--device", "--unknown"],
      ["--device=Phone", "--device="],
      ["--device", "Phone", "--device", "Other"],
      ["--unknown"],
      ["Phone"],
    ]
    for (const args of invalid) {
      const result = await executeDevecoCliProxy(["log", "clear", ...args], "/unused", cli.run, {
        findHome: async () => {
          throw new Error("Invalid arguments must not reach device operations")
        },
      })
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Usage:")
    }
    expect(cli.calls).toEqual([])
  })

  test("never clears logs when the target cannot be uniquely resolved", async () => {
    await using tmp = await tmpdir()
    await Bun.write(hdcPath(tmp.path), "hdc")
    const scenarios = [
      { args: [], stdout: DEVICES, error: "DEVICE_SELECTION_REQUIRED" },
      { args: [], stdout: "[]", error: "NO_DEVICE_AVAILABLE" },
      { args: ["--device=Missing"], stdout: DEVICES, error: "DEVICE_NOT_FOUND" },
      {
        args: ["--device=Phone"],
        stdout: '[{"name":"Phone","serial":"A"},{"name":"Phone","serial":"B"}]',
        error: "DEVICE_SELECTION_REQUIRED",
      },
      { args: ["--device=Phone"], stdout: '[{"name":"Phone","serial":"-"}]', error: "DEVICE_SERIAL_UNAVAILABLE" },
      { args: [], stdout: "not JSON", error: "Unable to parse" },
    ]
    for (const scenario of scenarios) {
      const result = await executeDevecoCliProxy(
        ["log", "clear", ...scenario.args],
        tmp.path,
        runner({ "device list --format json": { stdout: scenario.stdout } }).run,
        {
          findHome: async () => tmp.path,
          runCommand: async () => {
            throw new Error("An unresolved target must not be cleared")
          },
        },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(scenario.error)
      expect(result.stdout).not.toContain("Device log buffer cleared.")
    }
  })

  test("preserves discovery failures without attempting log clear", async () => {
    await using tmp = await tmpdir()
    await Bun.write(hdcPath(tmp.path), "hdc")
    const failure = { stdout: "device discovery failed\n", stderr: "connection unavailable\n", exitCode: 7 }
    const result = await executeDevecoCliProxy(
      ["log", "clear", "--device=Phone"],
      tmp.path,
      runner({ "device list --format json": failure }).run,
      {
        findHome: async () => tmp.path,
        runCommand: async () => {
          throw new Error("Failed discovery must not clear logs")
        },
      },
    )
    expect(result).toEqual(failure)
  })

  test("preserves hdc failures even when hdc exits with zero", async () => {
    await using tmp = await tmpdir()
    await Bun.write(hdcPath(tmp.path), "hdc")
    const cli = runner({ "device list --format json": { stdout: DEVICES } })
    const failures = [
      { stdout: "[Fail]Not match target founded, check connect-key please\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "\u001b[31m[Fail]device offline\u001b[0m\n", exitCode: 0 },
      { stdout: "error: permission denied\n", stderr: "", exitCode: 0 },
      { stdout: "Clear log buffer failed\n", stderr: "", exitCode: 0 },
      { stdout: "hdc output\n", stderr: "connection closed\n", exitCode: 9 },
    ]
    for (const failure of failures) {
      const result = await executeDevecoCliProxy(["log", "clear", "--device=Phone"], tmp.path, cli.run, {
        findHome: async () => tmp.path,
        runCommand: async () => failure,
      })
      expect(result).toEqual({ ...failure, exitCode: failure.exitCode || 1 })
      expect(result.stdout).not.toContain("Device log buffer cleared.")
    }
  })

  test.skipIf(process.platform === "win32")("detects failure output from an actual hdc subprocess", async () => {
    await using tmp = await tmpdir()
    const failure = "[Fail]Not match target founded, check connect-key please\n"
    // Use a local executable fixture: never clear a real device's logs in tests.
    await Bun.write(hdcPath(tmp.path), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(failure)})\n`)
    await fs.chmod(hdcPath(tmp.path), 0o755)
    const result = await executeDevecoCliProxy(
      ["log", "clear", "--device=Phone"],
      tmp.path,
      runner({ "device list --format json": { stdout: DEVICES } }).run,
      {
        findHome: async () => tmp.path,
      },
    )

    expect(result).toEqual({ stdout: failure, stderr: "", exitCode: 1 })
  })
})
