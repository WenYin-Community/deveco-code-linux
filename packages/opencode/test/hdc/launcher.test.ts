import { describe, expect, test } from "bun:test"
import path from "node:path"
import { resolveHdcShimLauncher } from "../../src/hdc/launcher"
import { HdcIpcServer } from "../../src/hdc/ipc-server"
import { tmpdir } from "../fixture/fixture"

async function runShim(
  directory: string,
  args: string[],
  env: Record<string, string | undefined>,
  prefix = ["__hdc-shim", "--"],
) {
  const child = Bun.spawn([...resolveHdcShimLauncher(), ...prefix, ...args], {
    cwd: directory,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
  ])
  return { exitCode, stdout, stderr }
}

describe("independent HDC shim launcher", () => {
  test.each(["/$bunfs/root/src/index.js", "B:/~BUN/root/src/index.js"])(
    "re-enters the compiled host for %s",
    (main) => {
      expect(resolveHdcShimLauncher(main, process.execPath)).toEqual([process.execPath])
    },
  )

  test("refuses unguarded execution from an unrelated project directory", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project with spaces")
    await Bun.write(path.join(project, "tsconfig.json"), '{"compilerOptions":{"paths":{"@/*":["unrelated/*"]}}}')

    const result = await runShim(project, ["list", "targets"], {
      ...process.env,
      DEVECO_CODE_HDC_ENDPOINT: "",
      DEVECO_CODE_HDC_TOKEN: "",
      DEVECO_CODE_HDC_SESSION: "",
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("reason_code=guard_unavailable")
  })

  test.each([["__hdc-shim", "--"], ["__hdc-shim"], []])(
    "forwards argv, session, cwd, output and exit code with prefix %j",
    async (...prefix) => {
      await using tmp = await tmpdir()
      const project = path.join(tmp.path, "project with spaces")
      await Bun.write(path.join(project, "tsconfig.json"), '{"compilerOptions":{"paths":{"@/*":["unrelated/*"]}}}')
      const server = await HdcIpcServer.startHdcIpcServer(async (ctx) => {
        expect(ctx.request.argv).toEqual(["shell", "echo", "argument with spaces", "--help"])
        expect(ctx.request.sessionID).toBe("ses_independent_hdc")
        expect(ctx.request.callID).toBe("call_independent_hdc")
        expect(ctx.request.cwd).toBe(project)
        await new Promise<void>((resolve) => ctx.attachStdin({ onStdin() {}, onStdinEnd: resolve }))
        ctx.emitStdout(Buffer.from("guarded output"))
        ctx.emitStderr(Buffer.from("guarded error"))
        return 7
      })
      try {
        const result = await runShim(
          project,
          ["shell", "echo", "argument with spaces", "--help"],
          {
            ...process.env,
            DEVECO_CODE_HDC_ENDPOINT: server.endpoint,
            DEVECO_CODE_HDC_TOKEN: server.token,
            DEVECO_CODE_HDC_SESSION: "ses_independent_hdc",
            DEVECO_CODE_HDC_CALL: "call_independent_hdc",
          },
          prefix,
        )

        expect(result).toEqual({ exitCode: 7, stdout: "guarded output", stderr: "guarded error" })
      } finally {
        await server.close()
      }
    },
  )
})
