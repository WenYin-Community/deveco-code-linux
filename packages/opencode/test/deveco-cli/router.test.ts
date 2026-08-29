import { describe, expect, test } from "bun:test"
import { executeDevecoCliProxy, type CliResult } from "../../src/deveco-cli/router"

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

  test("truncates docs search output longer than 5000 characters and preserves success", async () => {
    const args = ["docs", "search", "@State", "--limit", "10"]
    const cli = runner({ "docs search @State --limit 10": { stdout: "x".repeat(5_001) } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout.length + result.stderr.length).toBe(5_000)
    expect(result.stdout).toEndWith("[Documentation output truncated to 5000 characters.]\n")
    expect(result.exitCode).toBe(0)
  })

  test("preserves docs output at the 5000 character boundary", async () => {
    const args = ["docs", "read", "document-id"]
    const output = `${"x".repeat(4_999)}\n`
    const cli = runner({ "docs read document-id": { stdout: output } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout).toBe(output)
  })

  test("truncates combined docs stdout and stderr to 5000 characters", async () => {
    const args = ["docs", "read", "document-id"]
    const cli = runner({ "docs read document-id": { stdout: "x".repeat(4_000), stderr: "y".repeat(2_000) } })
    const result = await executeDevecoCliProxy(args, "C:\\project", cli.run)

    expect(cli.calls).toEqual([args])
    expect(result.stdout.length + result.stderr.length).toBe(5_000)
    expect(result.stdout).toEndWith("[Documentation output truncated to 5000 characters.]\n")
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
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
})
