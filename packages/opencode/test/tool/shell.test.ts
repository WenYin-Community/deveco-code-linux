import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Cause, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { resolveSandboxWorkspaceRoots, ShellTool } from "../../src/tool/shell"
import {
  ASK_DOCS_PREVIEW_CHARS,
  DOCS_PREVIEW_CHARS_ENV,
  DEVECO_IMAGE_DOWNLOAD_TIMEOUT_MS,
  resolveShellTimeout,
} from "../../src/agent/shell-policy"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { clearSessionCwd, getSessionCwd, setSessionCwd } from "@/tool/lib/session-cwd"

const shellLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  FSUtil.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  RuntimeFlags.defaultLayer,
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBash = initShell

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = <A, E, R>(item: { label: string; shell: string }, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = item.shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)))
  }
}

const capture = (requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.shell", () => {
  each("basic", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo test",
          description: "Echo test message",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      }),
    ),
  )

  it.live("falls back from terminal-only configured shell", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { shell: "fish" } })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const bash = yield* initBash()
          const fallback = Shell.name(Shell.acceptable("fish"))
          expect(fallback).not.toBe("fish")
          expect(bash.description).toContain(fallback)

          const result = yield* bash.execute(
            {
              command: "echo fallback",
              description: "Echo fallback text",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("fallback")
        }),
      )
    }),
  )
})

describe("tool.shell timeout policy", () => {
  test("extends deveco emulator image downloads to two hours", () => {
    expect(
      resolveShellTimeout('devecocli emulator image download --device-type phone --os-version "OS 6.0.2(22)"', 600_000),
    ).toBe(DEVECO_IMAGE_DOWNLOAD_TIMEOUT_MS)
    expect(resolveShellTimeout('"devecocli.cmd" emulator image download', 600_000)).toBe(
      DEVECO_IMAGE_DOWNLOAD_TIMEOUT_MS,
    )
  })

  test("preserves longer explicit and unrelated command timeouts", () => {
    const longer = DEVECO_IMAGE_DOWNLOAD_TIMEOUT_MS + 1
    expect(resolveShellTimeout("devecocli emulator image download", longer)).toBe(longer)
    expect(resolveShellTimeout("devecocli emulator image list", 600_000)).toBe(600_000)
  })
})

describe("tool.shell docs preview env", () => {
  const printDocsPreviewChars = () => {
    const code = `process.stdout.write(String(process.env.${DOCS_PREVIEW_CHARS_ENV}))`
    const text = `${bin} -e ${evalarg(code)}`
    return PS.has(sh()) ? `& ${text}` : text
  }

  it.live(
    "gives the ask agent the enlarged docs preview env",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run(
            { command: printDocsPreviewChars(), description: "Print docs preview chars" },
            { ...ctx, agent: "ask" },
          )

          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain(String(ASK_DOCS_PREVIEW_CHARS))
        }),
      ),
    30_000,
  )

  it.live(
    "removes an ambient docs preview override for non-ask agents",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const prev = process.env[DOCS_PREVIEW_CHARS_ENV]
          process.env[DOCS_PREVIEW_CHARS_ENV] = "999999"
          try {
            const result = yield* run({ command: printDocsPreviewChars(), description: "Print docs preview chars" })

            expect(result.metadata.exit).toBe(0)
            expect(result.output).toContain("undefined")
            expect(result.output).not.toContain("999999")
          } finally {
            if (prev === undefined) delete process.env[DOCS_PREVIEW_CHARS_ENV]
            else process.env[DOCS_PREVIEW_CHARS_ENV] = prev
          }
        }),
      ),
    30_000,
  )
})

describe("tool.shell Windows sandbox roots", () => {
  test.skipIf(process.platform !== "win32")("keeps the current workspace and de-duplicates configured roots", () => {
    const cwd = path.resolve("C:\\workspace")
    expect(resolveSandboxWorkspaceRoots(cwd, [cwd.toUpperCase(), "..\\shared", "..\\shared"])).toEqual([
      cwd,
      path.resolve(cwd, "..\\shared"),
    ])
  })

  test("expands home-relative roots", () => {
    expect(resolveSandboxWorkspaceRoots(path.resolve("C:\\workspace"), ["~\\sandbox-root"])).toContain(
      path.resolve(os.homedir(), "sandbox-root"),
    )
  })
})

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo hello",
              description: "Echo hello",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo hello")
        }),
      )
    }),
  )

  each("asks for bash permission with multiple commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo foo && echo bar",
              description: "Echo twice",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo foo")
          expect(requests[0].patterns).toContain("echo bar")
        }),
      )
    }),
  )

  for (const item of ps) {
    it.live(`parses PowerShell conditionals for permission prompts [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
                description: "Check PowerShell conditional",
              },
              capture(requests),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`uses PowerShell cmdlet prefixes for always-allow prompts [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Remove-Item -Recurse tmp",
                    description: "Remove a temp directory",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.always).toContain("Remove-Item *")
              expect(bashReq!.always).not.toContain("Remove-Item -Recurse *")
            }),
          )
        }),
      ),
    )
  }

  each("asks for external_directory permission for wildcard external paths", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        expect(
          yield* fail(
            {
              command: `cat ${file}`,
              description: "Read wildcard path",
            },
            capture(requests, err),
          ),
        ).toMatchObject({ message: err.message })
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
      }),
    ),
  )

  if (process.platform === "win32") {
    if (bash) {
      it.live("asks for nested bash command permissions [bash]", () =>
        withShell(
          { label: "bash", shell: bash },
          Effect.gen(function* () {
            const outerTmp = yield* tmpdirScoped()
            yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
            yield* runIn(
              projectRoot,
              Effect.gen(function* () {
                const file = path.join(outerTmp, "outside.txt").replaceAll("\\", "/")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                yield* run(
                  {
                    command: `echo $(cat "${file}")`,
                    description: "Read nested bash file",
                  },
                  capture(requests),
                )
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const bashReq = requests.find((r) => r.permission === "bash")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp, "*")))
                expect(bashReq).toBeDefined()
                expect(bashReq!.patterns).toContain(`cat "${file}"`)
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell paths after switches [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                    description: "Copy Windows ini",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for nested PowerShell command permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              yield* run(
                {
                  command: `Write-Output $(Get-Content ${file})`,
                  description: "Read nested PowerShell file",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                      description: "Read drive-relative file",
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $HOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$HOME/.ssh/config"',
                    description: "Read home config",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PWD PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                      description: "Read pwd-relative file",
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$PSHOME/outside.txt"',
                    description: "Read pshome file",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for missing PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = "DEVECO_TEST_MISSING"
              const prev = process.env[key]
              delete process.env[key]
              return { key, prev }
            }),
            ({ key }) =>
              runIn(
                projectRoot,
                Effect.gen(function* () {
                  const err = new Error("stop after permission")
                  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                  const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                  expect(
                    yield* fail(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                        description: "Read Windows ini with missing env",
                      },
                      capture(requests, err),
                    ),
                  ).toMatchObject({ message: err.message })
                  const extDirReq = requests.find((r) => r.permission === "external_directory")
                  expect(extDirReq).toBeDefined()
                  expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
                }),
              ),
            ({ key, prev }) =>
              Effect.sync(() => {
                if (prev === undefined) delete process.env[key]
                else process.env[key] = prev
              }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
                  description: "Read Windows ini from env",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                    description: "Read Windows ini from FileSystem provider",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for braced PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Get-Content ${env:WINDIR}/win.ini",
                    description: "Read Windows ini from braced env",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`treats Set-Location like cd for permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Set-Location C:/Windows",
                  description: "Change location",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not add nested PowerShell expressions to permission prompts [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Write-Output ('a' * 3)",
                  description: "Write repeated text",
                },
                capture(requests),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            }),
          ),
        ),
      )
    }
  }

  if (process.platform === "win32" && cmdShell) {
    it.live("asks for external_directory permission for cmd file commands [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
                description: "Read Windows ini with cmd",
              },
              capture(requests),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
          }),
        ),
      ),
    )
  }

  each("asks for external_directory permission when cd to parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cd ../",
                description: "Change to parent directory",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
        }),
      )
    }),
  )

  each("asks for external_directory permission when workdir is outside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
                description: "Echo from temp dir",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(glob(path.join(os.tmpdir(), "*")))
        }),
      )
    }),
  )

  it.live("uses session cwd by default and lets explicit workdir override it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const sessionDir = path.join(tmp, "session")
      const explicitDir = path.join(tmp, "explicit")
      yield* Effect.promise(() => Promise.all([fs.mkdir(sessionDir), fs.mkdir(explicitDir)]))
      const next = { ...ctx, sessionID: SessionID.make("ses_shell_cwd") }
      setSessionCwd(next.sessionID, sessionDir)

      try {
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const prefix = PS.has(sh()) ? "& " : ""
            const command = `${prefix}${bin} -e ${evalarg("console.log(process.cwd())")}`
            expect((yield* run({ command, description: "Print session cwd" }, next)).output).toContain(sessionDir)
            expect(
              (yield* run({ command, workdir: explicitDir, description: "Print explicit cwd" }, next)).output,
            ).toContain(explicitDir)
          }),
        )
      } finally {
        clearSessionCwd(next.sessionID)
      }
    }),
  )

  it.live("does not switch session cwd from unrelated Project root output", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const next = { ...ctx, sessionID: SessionID.make("ses_shell_fake_root") }
      const output = `Project root: ${path.join(tmp, "fake")}`
      const script = path.join(tmp, "print-project-root.mjs")
      yield* Effect.promise(() => Bun.write(script, `console.log(${JSON.stringify(output)})`))
      const prefix = PS.has(sh()) ? "& " : ""
      const result = yield* runIn(
        tmp,
        run(
          {
            command: `${prefix}${bin} ${quote(script)}`,
            description: "Print unrelated project root",
          },
          next,
        ),
      )
      expect(result.metadata.exit, result.output).toBe(0)
      expect(result.output).toContain(output)
      expect(getSessionCwd(next.sessionID)).toBeUndefined()
    }),
  )

  it.live("lets Harness own CLI event readback and synchronizes successful create directories", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const projectRoot = "created project"
      const target = path.join(tmp, projectRoot)
      yield* Effect.promise(() => fs.mkdir(target))
      const next = { ...ctx, sessionID: SessionID.make("ses_harness_create"), callID: "harness-create" }
      try {
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const payload = [
              JSON.stringify({ command: "create", exitCode: 0, durationMs: 1, projectRoot }),
              JSON.stringify({ command: "build", exitCode: 1, durationMs: 2 }),
              "not json",
              JSON.stringify({ command: "/private/project", exitCode: 0, durationMs: 3 }),
            ].join("\n")
            const code = `await Bun.write(process.env.DEVECO_CODE_CLI_EVENT_FILE, ${JSON.stringify(payload)})`
            const script = path.join(tmp, "emit-cli-events.mjs")
            yield* Effect.promise(() => Bun.write(script, code))
            const prefix = PS.has(sh()) ? "& " : ""
            const args = { command: `${prefix}${bin} ${quote(script)}`, description: "CLI event producer" }
            const input = { tool: "bash", sessionID: next.sessionID, callID: next.callID }
            yield* plugin.trigger("tool.execute.before", input, { args })
            const result = yield* run(args, next)
            expect(result.metadata.exit, result.output).toBe(0)
            expect(result.metadata).not.toHaveProperty("devecoCliEvents")
            yield* plugin.trigger("tool.execute.after", { ...input, args, source: "builtin" }, result)
            expect(result.metadata).toMatchObject({
              sessionCwd: target,
              devecoCliEvents: [
                { command: "create", exitCode: 0, durationMs: 1, projectRoot },
                { command: "build", exitCode: 1, durationMs: 2 },
              ],
            })
            expect(result.output).toContain(`[Session directory auto-switched to ${target}]`)
            expect(getSessionCwd(next.sessionID)).toBe(target)
            const command = `${prefix}${bin} -e ${evalarg("console.log(process.cwd())")}`
            expect((yield* run({ command, description: "Read next cwd" }, next)).output).toContain(target)
          }),
        )
      } finally {
        clearSessionCwd(next.sessionID)
      }
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes external_directory workdir variants on Windows", () =>
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const outerTmp = yield* tmpdirScoped()
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const want = Filesystem.normalizePathPattern(path.join(outerTmp, "*"))

            for (const dir of forms(outerTmp)) {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: dir,
                    description: "Echo from external dir",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })

              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
                dir,
                patterns: [want],
                always: [want],
              })
            }
          }),
        )
      }),
    )

    if (bash) {
      it.live("uses Git Bash /tmp semantics for external workdir", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: "/tmp",
                    description: "Echo from Git Bash tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )

      it.live("uses Git Bash /tmp semantics for external file paths", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "cat /tmp/opencode-does-not-exist",
                    description: "Read Git Bash tmp file",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", () =>
    Effect.gen(function* () {
      const outerTmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const filepath = path.join(outerTmp, "outside.txt")
          expect(
            yield* fail(
              {
                command: `cat ${filepath}`,
                description: "Read external file",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
          expect(extDirReq!.always).toContain(expected)
          expect(extDirReq!.metadata).toMatchObject({
            command: `cat ${filepath}`,
            description: "Read external file",
            directories: [outerTmp],
            patterns: [expected],
          })
        }),
      )
    }),
  )

  each("does not ask for external_directory permission when rm inside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp, "tmpfile"), "x"))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: `rm -rf ${path.join(tmp, "nested")}`,
              description: "Remove nested dir",
            },
            capture(requests),
          )
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        }),
      )
    }),
  )

  each("includes always patterns for auto-approval", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git log --oneline -5",
              description: "Git log",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].always.length).toBeGreaterThan(0)
          expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
        }),
      )
    }),
  )

  each("does not ask for bash permission when command is cd only", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cd .",
              description: "Stay in current directory",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeUndefined()
        }),
      )
    }),
  )

  each("matches redirects in permission pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              { command: "echo test > output.txt", description: "Redirect test output" },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.patterns).toContain("echo test > output.txt")
        }),
      )
    }),
  )

  each("always pattern has space before wildcard to not include different commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run({ command: "ls -la", description: "List" }, capture(requests))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always[0]).toBe("ls *")
        }),
      )
    }),
  )
})

describe("tool.shell abort", () => {
  it.live(
    "preserves output when aborted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const collected: string[] = []
          const res = yield* run(
            {
              command: PS.has(sh()) ? "Write-Output before; Start-Sleep -Seconds 30" : "echo before && sleep 30",
              description: "Long running command",
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output?.split(/\r?\n/).includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          )
          expect(res.output).toContain("before")
          expect(res.output).toContain("User aborted the command")
          expect(collected.length).toBeGreaterThan(0)
        }),
      ),
    // Native sandbox and shell cold-start time is included in this deadline.
    30_000,
  )

  it.live(
    "terminates command on timeout",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `sleep 60`,
            description: "Timeout test",
            timeout: 500,
          })
          expect(result.output).toContain("shell tool terminated command after exceeding timeout")
          expect(result.output).toContain("retry with a larger timeout value in milliseconds")
        }),
      ),
    15_000,
  )

  it.live(
    "uses RuntimeFlags bashDefaultTimeoutMs when timeout is omitted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const tool = yield* initShell()
          expect(tool.description).toContain("commands will time out after 500ms")
          const result = yield* tool.execute(
            {
              command: `sleep 60`,
              description: "Default timeout test",
            },
            ctx,
          )
          expect(result.output).toContain("exceeding timeout 500 ms")
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: 500 }))),
    15_000,
  )

  if (process.platform !== "win32") {
    it.live("captures stderr in output", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo stdout_msg && echo stderr_msg >&2`,
            description: "Stderr test",
          })
          expect(result.output).toContain("stdout_msg")
          expect(result.output).toContain("stderr_msg")
          expect(result.metadata.exit).toBe(0)
        }),
      ),
    )
  }

  it.live("returns non-zero exit code", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: `exit 42`,
          description: "Non-zero exit",
        })
        expect(result.metadata.exit).toBe(42)
      }),
    ),
  )

  it.live("streams metadata updates progressively", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const updates: string[] = []
        // Use cross-shell compatible chaining with a small delay to ensure
        // multiple metadata updates. bash/cmd use `&&` + `sleep`, PowerShell
        // uses `;` + `Start-Sleep`.
        const sh = Shell.name(Shell.acceptable())
        const isPowerShell = sh === "pwsh" || sh === "powershell"
        const command = isPowerShell
          ? 'Write-Output "first"; Start-Sleep -Milliseconds 300; Write-Output "second"'
          : "echo first && sleep 0.3 && echo second"
        const result = yield* run(
          {
            command,
            description: "Streaming test",
          },
          {
            ...ctx,
            metadata: (input) =>
              Effect.sync(() => {
                const output = (input.metadata as { output?: string })?.output
                if (output) updates.push(output)
              }),
          },
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThan(1)
      }),
    ),
  )
})

describe("tool.shell truncation", () => {
  it.live("truncates output exceeding line limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 500
        const result = yield* run({
          command: fill("lines", lineCount),
          description: "Generate lines exceeding limit",
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("truncates output exceeding byte limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = yield* run({
          command: fill("bytes", byteCount),
          description: "Generate bytes exceeding limit",
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("does not truncate small output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: fill("lines", 1),
          description: "Generate one line",
        })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("1")
      }),
    ),
  )

  it.live("full output is saved to file when truncated", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 100
        const result = yield* run({
          command: fill("lines", lineCount),
          description: "Generate lines for file check",
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* FSUtil.Service).readFileString(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      }),
    ),
  )
})

// D2A observations carry the host binding (session, assistant message, callID,
// bundle name) that analytics uses for run attribution. Assertions about the
// workflow evidence itself compare the observation without it.
function stripBinding(observation: Record<string, unknown>): Record<string, unknown> {
  const { binding: _binding, ...rest } = observation
  return rest
}

describe("tool.shell d2a workflow observation", () => {  const controllerScript = quote(
    path.join(projectRoot, "resources", "skills", "hmos-design-to-arkts", "scripts", "workflow.mjs"),
  )
  const d2a = (args: string) => {
    const text = `${bin} ${controllerScript} ${args}`
    return PS.has(sh()) ? `& ${text}` : text
  }
  // ctx.extra.model mirrors what session/tools.ts provides; the logical id must
  // be projected, not api.id.
  const d2aCtx = (model: { providerId: string; modelId: string }) => ({
    ...ctx,
    extra: {
      model: {
        providerID: model.providerId,
        id: model.modelId,
        api: { id: `${model.modelId}-api` },
      },
    },
  })
  const modelA = { providerId: "deveco", modelId: "glm-logical" }
  const ctxA = d2aCtx(modelA)
  const snapshots = (result: { metadata: Record<string, unknown> }) =>
    (result.metadata.d2aWorkflowSnapshots as Array<Record<string, unknown>>).map(stripBinding)
  const rawSnapshots = (result: { metadata: Record<string, unknown> }) =>
    result.metadata.d2aWorkflowSnapshots as Array<Record<string, unknown>>

  each("d2a: init is attributed, status and non-ready stage-start are rereads", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const runDir = path.join(tmp, "runs", "run-1")
          const init = yield* run(
            {
              command: d2a(`--mode init --source pixso --variant full --run-dir ${quote(runDir)}`),
              description: "D2A workflow init",
            },
            ctxA,
          )
          expect(init.metadata.exit).toBe(0)
          expect(snapshots(init)).toEqual([
            {
              operation: "init",
              replayed: false,
              model: modelA,
              // A verified fresh init also carries the build tracking marker.
              buildTrackingStartedAtInit: true,
              snapshot: expect.objectContaining({
                revision: 1,
                designSource: "pixso",
                variant: "full",
                status: "running",
                completedStages: [],
                stages: [],
                runId: expect.any(String),
              }),
            },
          ])

          const status = yield* run(
            {
              command: d2a(`--mode status --run-dir ${quote(runDir)}`),
              description: "D2A workflow status",
            },
            ctxA,
          )
          expect(snapshots(status)).toEqual([
            {
              operation: "status",
              replayed: true,
              snapshot: expect.objectContaining({ revision: 1, status: "running" }),
            },
          ])

          const start = yield* run(
            {
              command: d2a(`--mode stage-start --run-dir ${quote(runDir)} --stage 1`),
              description: "D2A workflow stage start",
            },
            ctxA,
          )
          expect(snapshots(start)).toEqual([
            {
              operation: "stage-start",
              replayed: false,
              model: modelA,
              snapshot: expect.objectContaining({ revision: 2, status: "running" }),
            },
          ])

          // ready=false still exits 0; it committed nothing, so it is a reread.
          const notReady = yield* run(
            {
              command: d2a(`--mode stage-start --run-dir ${quote(runDir)} --stage 5`),
              description: "D2A workflow stage start (not ready)",
            },
            ctxA,
          )
          expect(notReady.metadata.exit).toBe(0)
          expect(snapshots(notReady)).toEqual([
            {
              operation: "stage-start",
              replayed: true,
              snapshot: expect.objectContaining({ revision: 2 }),
            },
          ])
        }),
      )
    }),
  )

  each("d2a: observations carry the host binding used for run attribution", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const runDir = path.join(tmp, "runs", "run-1")
          // The callID is the tool-call identity analytics joins the measurement by.
          const init = yield* run(
            {
              command: d2a(`--mode init --source pixso --variant full --run-dir ${quote(runDir)}`),
              description: "D2A workflow init",
            },
            { ...ctxA, callID: "call-d2a-init" },
          )
          expect(rawSnapshots(init)).toEqual([
            expect.objectContaining({
              binding: { sessionID: "ses_test", messageID: "msg_test", callID: "call-d2a-init" },
            }),
          ])
          // No AppScope in the fixture project: the bundle name is omitted, never "".
          expect((rawSnapshots(init)[0].binding as Record<string, unknown>).bundleName).toBeUndefined()
        }),
      )
    }),
  )

  each("d2a: failed controller commands are rereads and never attributed to a model", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const runDir = path.join(tmp, "runs", "run-1")
          yield* run(
            {
              command: d2a(`--mode init --source pixso --variant full --run-dir ${quote(runDir)}`),
              description: "D2A workflow init",
            },
            ctxA,
          )
          // Stage 1 does not require confirmation, so this fails before any write.
          const failed = yield* run(
            {
              command: d2a(`--mode confirm --run-dir ${quote(runDir)} --stage 1 --decision accepted`),
              description: "D2A workflow confirm (invalid)",
            },
            ctxA,
          )
          expect(failed.metadata.exit).toBe(1)
          expect(snapshots(failed)).toEqual([
            {
              operation: "confirm",
              replayed: true,
              snapshot: expect.objectContaining({ revision: 1, status: "running" }),
            },
          ])
        }),
      )
    }),
  )

  each("d2a: two runs keep independent models", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const modelB = { providerId: "deveco", modelId: "glm-other" }
          const ctxB = d2aCtx(modelB)
          const first = yield* run(
            {
              command: d2a(`--mode init --source figma --variant full --run-dir ${quote(path.join(tmp, "runs", "a"))}`),
              description: "D2A workflow init A",
            },
            ctxA,
          )
          const second = yield* run(
            {
              command: d2a(`--mode init --source pixso --variant fast --run-dir ${quote(path.join(tmp, "runs", "b"))}`),
              description: "D2A workflow init B",
            },
            ctxB,
          )
          const firstSnapshot = snapshots(first)[0]
          const secondSnapshot = snapshots(second)[0]
          expect((firstSnapshot.model as { modelId: string }).modelId).toBe(modelA.modelId)
          expect((secondSnapshot.model as { modelId: string }).modelId).toBe(modelB.modelId)
          expect((firstSnapshot.snapshot as { runId: string }).runId).not.toBe(
            (secondSnapshot.snapshot as { runId: string }).runId,
          )
        }),
      )
    }),
  )

  each("d2a: run directories outside the instance are not observed", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const outside = path.join(os.tmpdir(), `d2a-outside-run-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
          const result = yield* run(
            {
              command: d2a(`--mode status --run-dir ${quote(outside)}`),
              description: "D2A workflow status (outside)",
            },
            ctxA,
          )
          expect(result.metadata.exit).toBe(1)
          expect(result.metadata.d2aWorkflowSnapshots).toBeUndefined()
        }),
      )
    }),
  )

  for (const item of shells.filter((shell) => shell.label === "bash" || PS.has(shell.label))) {
    it.live(`d2a: quoted run directory with spaces and CJK characters [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const runDir = path.join(tmp, "runs", "run with 空格")
              const init = yield* run(
                {
                  command: d2a(`--mode init --source figma --variant full --run-dir ${quote(runDir)}`),
                  description: "D2A workflow init (spaced run dir)",
                },
                ctxA,
              )
              expect(init.metadata.exit).toBe(0)
              expect(snapshots(init)).toEqual([
                {
                  operation: "init",
                  replayed: false,
                  model: modelA,
                  buildTrackingStartedAtInit: true,
                  snapshot: expect.objectContaining({ designSource: "figma", revision: 1 }),
                },
              ])
            }),
          )
        }),
      ),
    )

    it.live(`d2a: compound commands with two controller calls stay rereads [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const runDir = path.join(tmp, "runs", "run-1")
              yield* run(
                {
                  command: d2a(`--mode init --source pixso --variant full --run-dir ${quote(runDir)}`),
                  description: "D2A workflow init",
                },
                ctxA,
              )
              // Windows PowerShell 5.1 has no `&&`; every shell here accepts `;`
              // except cmd, which needs `&&`.
              const chain = sh() === "cmd" ? "&&" : ";"
              const compound = yield* run(
                {
                  command: `${d2a(`--mode status --run-dir ${quote(runDir)}`)} ${chain} ${d2a(`--mode status --run-dir ${quote(runDir)}`)}`,
                  description: "D2A workflow compound status",
                },
                ctxA,
              )
              expect(compound.metadata.exit).toBe(0)
              // Two controller calls on one run: ownership is ambiguous, so the
              // observation stays a plain reread without operation or model.
              expect(snapshots(compound)).toEqual([
                {
                  replayed: true,
                  snapshot: expect.objectContaining({ revision: 1, status: "running" }),
                },
              ])
            }),
          )
        }),
      ),
    )
  }

  it.live("d2a: a run directory symlink escaping the instance is refused", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const outsideTarget = path.join(os.tmpdir(), `d2a-escape-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
          yield* Effect.promise(() => fs.mkdir(outsideTarget, { recursive: true }))
          const aliasRun = path.join(tmp, "alias-run")
          const linked = yield* Effect.promise(() =>
            fs
              .symlink(outsideTarget, aliasRun, process.platform === "win32" ? "junction" : "dir")
              .then(
                () => true,
                () => false,
              ),
          )
          if (!linked) return
          const init = yield* run(
            {
              command: d2a(`--mode init --source pixso --variant full --run-dir ${quote(aliasRun)}`),
              description: "D2A workflow init (symlinked run dir)",
            },
            ctxA,
          )
          expect(init.metadata.exit).toBe(0)
          // The command ran and wrote into the junction target, but the host
          // refuses to observe a run whose real path escapes the instance.
          expect(init.metadata.d2aWorkflowSnapshots).toBeUndefined()
          yield* Effect.promise(() => fs.rm(outsideTarget, { recursive: true, force: true }))
        }),
      )
    }),
  )

  // ─── PowerShell host variables (skill root and run dir bound first) ────────
  // A real Pixso run assigns both paths to local variables before the call, so
  // the static pass has to expand them to observe the run at all. The skill root
  // comes from an environment variable fixture instead of this machine's install
  // location, and the run directory carries spaces to keep quoting honest.
  const skillRootEnv = "D2A_SHELL_TEST_SKILL_ROOT"
  const skillRootDir = path.join(projectRoot, "resources", "skills", "hmos-design-to-arkts")
  const withSkillRoot = <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env[skillRootEnv]
        process.env[skillRootEnv] = skillRootDir
        return previous
      }),
      () => self,
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env[skillRootEnv]
          else process.env[skillRootEnv] = previous
        }),
    )
  // The shape under test: `$skillRoot` and `$runDir` bound in the same call as
  // the controller invocation, exactly like the Pixso Full run that exposed the
  // missing observation.
  const varCommand = (runDir: string, args: string) =>
    [
      `$skillRoot = "$env:${skillRootEnv}"`,
      `$runDir = "${runDir}"`,
      `& ${bin} "$skillRoot\\scripts\\workflow.mjs" ${args}`,
    ].join("\n")
  const varRunDir = (tmp: string) => path.join(tmp, "runs", "run with 空格")

  for (const item of ps) {
    it.live(`d2a: host variables resolve the controller script and run directory [${item.label}]`, () =>
      withShell(
        item,
        withSkillRoot(
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const runDir = varRunDir(tmp)
                const init = yield* run(
                  {
                    command: varCommand(runDir, '--mode init --source pixso --variant full --run-dir "$runDir"'),
                    description: "D2A variable init",
                  },
                  ctxA,
                )
                expect(init.metadata.exit).toBe(0)
                // The fresh run is observed as a real init: the tracking origin
                // is established on the very call that bound its own paths.
                expect(snapshots(init)).toEqual([
                  {
                    operation: "init",
                    replayed: false,
                    model: modelA,
                    buildTrackingStartedAtInit: true,
                    snapshot: expect.objectContaining({
                      revision: 1,
                      designSource: "pixso",
                      status: "running",
                      runId: expect.any(String),
                    }),
                  },
                ])
                const runId = (snapshots(init)[0].snapshot as { runId: string }).runId

                // A later call in a new shell invocation keeps resolving the same
                // run through the same variable form.
                const start = yield* run(
                  {
                    command: varCommand(runDir, '--mode stage-start --stage 1 --run-dir "$runDir"'),
                    description: "D2A variable stage start",
                  },
                  ctxA,
                )
                expect(start.metadata.exit).toBe(0)
                expect(snapshots(start)).toEqual([
                  {
                    operation: "stage-start",
                    replayed: false,
                    model: modelA,
                    snapshot: expect.objectContaining({ revision: 2, runId }),
                  },
                ])

                // PowerShell variable names are case-insensitive, so a differently
                // cased reference resolves the value bound above.
                const cased = yield* run(
                  {
                    command: [
                      `$RUNdir = "${runDir}"`,
                      `& ${bin} ${controllerScript} --mode status --run-dir "$runDir"`,
                    ].join("\n"),
                    description: "D2A variable casing",
                  },
                  ctxA,
                )
                expect(cased.metadata.exit).toBe(0)
                expect(snapshots(cased)).toEqual([
                  {
                    operation: "status",
                    replayed: true,
                    snapshot: expect.objectContaining({ revision: 2, runId }),
                  },
                ])
              }),
            )
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`d2a: unsafe host-variable forms are not observed [${item.label}]`, () =>
      withShell(
        item,
        withSkillRoot(
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const runDir = path.join(tmp, "runs", "run-1")
                yield* run(
                  {
                    command: varCommand(runDir, '--mode init --source pixso --variant full --run-dir "$runDir"'),
                    description: "D2A variable init",
                  },
                  ctxA,
                )
                const cases = [
                  // A subexpression is evaluated by PowerShell, but not by a
                  // static pass that refuses to run expressions.
                  {
                    label: "subexpression",
                    command: `$runDir = "${runDir}"\n& ${bin} ${controllerScript} --mode status --run-dir "$($runDir)"`,
                    exit: 0,
                  },
                  // A conditional assignment has no provable value at the call.
                  {
                    label: "conditional assignment",
                    command: `if ($true) { $runDir = "${runDir}" }\n& ${bin} ${controllerScript} --mode status --run-dir "$runDir"`,
                    exit: 0,
                  },
                  // Inside single quotes PowerShell keeps `$runDir` literal.
                  {
                    label: "single-quoted variable",
                    command: `$runDir = "${runDir}"\n& ${bin} ${controllerScript} --mode status --run-dir '$runDir'`,
                    exit: 1,
                  },
                  // An unset variable expands to nothing in PowerShell.
                  {
                    label: "unset variable",
                    command: `& ${bin} ${controllerScript} --mode status --run-dir "$notDefinedAnywhere"`,
                    exit: 1,
                  },
                ]
                for (const form of cases) {
                  const result = yield* run({ command: form.command, description: `D2A ${form.label} status` }, ctxA)
                  // The command always runs; only the observation is dropped.
                  expect(result.metadata.exit).toBe(form.exit)
                  expect(result.metadata.d2aWorkflowSnapshots).toBeUndefined()
                }
              }),
            )
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`d2a: a host variable pointing outside the instance is not observed [${item.label}]`, () =>
      withShell(
        item,
        withSkillRoot(
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const outside = path.join(
                  os.tmpdir(),
                  `d2a-outside-var-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
                )
                yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
                // Path expansion succeeds; the existing instance boundary then
                // refuses the run directory exactly like a literal one.
                const command = [
                  `$runDir = "${outside}"`,
                  `& ${bin} ${controllerScript} --mode status --run-dir "$runDir"`,
                ].join("\n")
                const result = yield* run({ command, description: "D2A variable outside run" }, ctxA)
                // The command itself still fails on the missing run; only the
                // observation is what the boundary suppresses.
                expect(result.metadata.exit).not.toBe(0)
                expect(result.metadata.d2aWorkflowSnapshots).toBeUndefined()
                yield* Effect.promise(() => fs.rm(outside, { recursive: true, force: true }))
              }),
            )
          }),
        ),
      ),
    )
  }

  // others-html fast is the shortest catalog (five stages), so the final
  // stage-complete can be reached without preparing every Pixso Full gate. The
  // artifact shapes mirror the controller regression fixture, which registers its
  // own tests and therefore cannot be imported; only the fast subset is kept.
  const seedHtmlFast = (() => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    )
    // Fixed epoch base and a non-boundary clock for the build report: the gates
    // only need timestamps the controller accepts, never the wall clock.
    const t0 = 1_700_000_000_000
    const now = Date.now() - 61_000
    const honest = new Date(now - (now % 1000) + 123).toISOString()
    const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")
    const json = async (dir: string, relative: string, value: unknown) => {
      const file = path.join(dir, ...relative.split("/"))
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
    }
    return async (dir: string) => {
      const input = "<html><body><div>hello</div></body></html>"
      await fs.mkdir(path.join(dir, "source", "html", "reference"), { recursive: true })
      await fs.writeFile(path.join(dir, "source", "html", "input.html"), input)
      await fs.writeFile(path.join(dir, "source", "html", "reference", "reference-00.png"), png)
      await fs.writeFile(path.join(dir, "source", "html", "reference", "reference-full.png"), "stitched reference frames")
      const inputSha = sha256(input)
      await json(dir, "requirement-clarification.json", {
        preCheckCompleted: true,
        designSource: "others-html",
        visualCalibration: { enabled: true, scoreThreshold: 80 },
      })
      await json(dir, "inputs-manifest.json", {
        designSource: "others-html",
        htmlSource: { path: "source/html/input.html", sha256: inputSha },
        layoutFactsPath: "stage1/layout-facts.json",
        visualSpecPath: "stage1/visual-spec.json",
        referenceSet: {
          dir: "source/html/reference",
          frames: ["reference-00.png"],
          contentFull: "reference-full.png",
          content: { frames: 1 },
          deviceScaleFactor: 1,
          logicalCanvas: { width: 1, height: 1 },
        },
      })
      await json(dir, "stage1/layout-facts.json", {
        schemaVersion: 1,
        designSource: "others-html",
        source: { path: "source/html/input.html", sha256: inputSha },
        render: {
          deviceScaleFactor: 1,
          canvas: { logicalWidth: 1, logicalHeight: 1, physicalWidth: 1, physicalHeight: 1 },
          content: { coverage: 1, extentPx: 1, visibleCoverage: 1, frames: 1 },
          statusBarVp: 0,
          gestureBarVp: 0,
        },
        nodes: [{ nodeId: "n1", rect: { x: 0, y: 0, w: 1, h: 1 }, text: "hello" }],
        systemUi: [],
        uncertainties: [],
      })
      await json(dir, "stage1/visual-spec.json", {
        schemaVersion: 1,
        designSource: "others-html",
        canvasIncludesSystemBar: false,
        roles: [],
        systemUi: [],
        notImplemented: [],
        unknowns: ["none"],
      })
      await json(dir, "stage1/source-freeze.json", {
        producer: "html_source_freeze",
        input: "source/html/input.html",
        sha256: inputSha,
        resources: { total: 1, missing: 0 },
      })
      await json(dir, "stage2/generated-ui-manifest.json", {
        page: { file: "entry/src/main/ets/pages/HtmlPage.ets", component: "HtmlPage", hasEntry: false },
        registration: {
          mode: "existing-router",
          route: "html_page",
          file: "route/map.json",
          default: false,
          component: "HtmlPage",
        },
        startup: { entryAbilityPage: "pages/Index", mainPagesContainsIndex: true },
        reachability: "entry-point-exists",
      })
      await json(dir, "stage2/initial-build-report.json", {
        success: true,
        command: "hvigorw assembleHap",
        exitCode: 0,
        completedAt: honest,
      })
      await json(dir, "stage4/quality-audit.json", {
        criticalIssues: [],
        majorIssues: [],
        audits: {
          structureAndValues: { pass: true },
          hds: { pass: true },
          systemUi: { pass: true },
          safeArea: { pass: true },
          topCollision: { pass: true },
          resources: { pass: true },
          routing: { pass: true },
          codeQuality: { pass: true },
        },
        buildResult: { exitCode: 0, command: "hvigorw assembleHap" },
      })
      await json(dir, "hds-decision.json", { hdsRequired: false })
      await json(dir, "input-security-report.json", { schemaVersion: 1, status: "clean" })
      await json(dir, "capability-invocation-ledger.json", [
        { capability: "hmos-d2a-html-to-arkui", status: "completed" },
        { capability: "hmos-d2a-solution-design", status: "completed" },
        { capability: "hmos-d2a-arkts-logic-completer", status: "completed" },
      ])
      for (const [relative, text] of [
        ["stage2/component-analysis.md", "component analysis\n"],
        ["stage3-interaction-report.md", "interaction report\n"],
        ["stage4/build-report.md", "build report\n"],
        ["design-doc.md", "# design doc\n"],
        ["component-tree.md", "- n1 Button\n"],
        ["completeness-report.md", "summary\n"],
      ] as const) {
        await fs.writeFile(path.join(dir, ...relative.split("/")), text)
      }
      // Gates for the completed stages, then the state that records them: the
      // fast catalog has no confirmation stage, so no stage-2 snapshot is owed.
      for (const stage of [1, 2, 3, 4]) {
        await json(dir, `stage-gates/stage${String(stage).padStart(2, "0")}-gate.json`, {
          stage,
          status: "passed",
          completedAt: new Date(t0 + stage * 1000).toISOString(),
        })
      }
      const file = path.join(dir, "workflow-state.json")
      const state = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
      await fs.writeFile(
        file,
        `${JSON.stringify({ ...state, completedStages: [1, 2, 3, 4], currentStage: 5 }, null, 2)}\n`,
      )
    }
  })()

  for (const item of ps) {
    it.live(`d2a: the final stage completes in the call that bound its own paths [${item.label}]`, () =>
      withShell(
        item,
        withSkillRoot(
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const runDir = varRunDir(tmp)
                const init = yield* run(
                  {
                    command: varCommand(runDir, '--mode init --source others-html --variant fast --run-dir "$runDir"'),
                    description: "D2A variable init (fast catalog)",
                  },
                  ctxA,
                )
                expect(init.metadata.exit).toBe(0)
                const runId = (snapshots(init)[0].snapshot as { runId: string }).runId
                expect(snapshots(init)[0].buildTrackingStartedAtInit).toBe(true)

                yield* Effect.promise(() => seedHtmlFast(runDir))
                // No extra `status` call: the completion itself is observed, which
                // is what makes the delivery event queue on the same call.
                const final = yield* run(
                  {
                    command: varCommand(runDir, '--mode stage-complete --run-dir "$runDir" --stage 5 --result passed'),
                    description: "D2A variable final stage",
                  },
                  ctxA,
                )
                expect(final.metadata.exit).toBe(0)
                expect(snapshots(final)).toEqual([
                  {
                    operation: "stage-complete",
                    replayed: false,
                    model: modelA,
                    snapshot: expect.objectContaining({
                      runId,
                      status: "completed",
                      completedStages: [1, 2, 3, 4, 5],
                    }),
                  },
                ])
              }),
            )
          }),
        ),
      ),
    )
  }

  // ─── marked standalone build observation (first/final build outcome) ──────
  // ctx.callID is the tool call id the build result is keyed by.
  const buildCtx = (callId: string) => ({ ...ctxA, callID: callId })
  const initRun = (dir: string, source = "pixso") =>
    run(
      {
        command: d2a(`--mode init --source ${source} --variant full --run-dir ${quote(dir)}`),
        description: "D2A workflow init",
      },
      ctxA,
    )
  const buildCommand = (success: boolean) => {
    const code = success ? "process.exit(0)" : "process.exit(3)"
    const text = `${bin} -e ${evalarg(code)}`
    return PS.has(sh()) ? `& ${text}` : text
  }

  each("d2a: a marked build records its exit outcome and the init marker", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const runDir = path.join(tmp, "runs", "run-1")
          const init = yield* initRun(runDir)
          // The real init observation carries the tracking-start marker.
          expect(snapshots(init)[0].buildTrackingStartedAtInit).toBe(true)

          const failed = yield* run(
            {
              command: buildCommand(false),
              description: "D2A marked build (failure)",
              d2aBuildRunDir: runDir,
            },
            buildCtx("call-build-fail"),
          )
          // Non-zero is the contract: Windows PowerShell 5.1's -Command
          // wrapper may collapse a native non-zero exit (3 here) to 1, and
          // the sandbox prepare path keeps the wrapper's code as-is. Both
          // stay failures, so the recorded boolean is unaffected.
          expect(failed.metadata.exit).not.toBe(0)
          const failedSnapshots = snapshots(failed)
          expect(failedSnapshots).toHaveLength(1)
          expect(failedSnapshots[0]).toEqual({
            replayed: true,
            snapshot: expect.objectContaining({ status: "running" }),
            buildResult: { callId: "call-build-fail", completedAtMs: expect.any(Number), success: false },
          })

          const succeeded = yield* run(
            {
              command: buildCommand(true),
              description: "D2A marked build (success)",
              d2aBuildRunDir: runDir,
            },
            buildCtx("call-build-ok"),
          )
          expect(succeeded.metadata.exit).toBe(0)
          expect(snapshots(succeeded)[0].buildResult).toEqual({
            callId: "call-build-ok",
            completedAtMs: expect.any(Number),
            success: true,
          })
        }),
      )
    }),
  )

  each("d2a: unmarked, compound and out-of-scope builds are not observed", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const runDir = path.join(tmp, "runs", "run-1")
          yield* initRun(runDir)

          // No marker: nothing.
          const unmarked = yield* run(
            { command: buildCommand(true), description: "Unmarked build" },
            buildCtx("call-unmarked"),
          )
          expect(unmarked.metadata.d2aWorkflowSnapshots).toBeUndefined()

          // Build combined with a deploy-like follow-up: exit attribution is
          // ambiguous, so no observation even with the marker.
          const chain = sh() === "cmd" ? "&&" : ";"
          const compound = yield* run(
            {
              command: `${buildCommand(true)} ${chain} ${buildCommand(true)}`,
              description: "Compound build plus deploy",
              d2aBuildRunDir: runDir,
            },
            buildCtx("call-compound"),
          )
          expect(compound.metadata.exit).toBe(0)
          expect(compound.metadata.d2aWorkflowSnapshots).toBeUndefined()

          // Marker outside the instance: refused, command still runs.
          const outside = path.join(os.tmpdir(), `d2a-outside-build-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
          yield* Effect.promise(() => fs.mkdir(path.join(outside, "runs"), { recursive: true }))
          const escaped = yield* run(
            {
              command: buildCommand(true),
              description: "Marked build (outside instance)",
              d2aBuildRunDir: outside,
            },
            buildCtx("call-outside"),
          )
          expect(escaped.metadata.exit).toBe(0)
          expect(escaped.metadata.d2aWorkflowSnapshots).toBeUndefined()
        }),
      )
    }),
  )

  each("d2a: a marked build against a missing or completed run is skipped", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          // Missing run directory: no observation (init has not run).
          const missing = yield* run(
            {
              command: buildCommand(true),
              description: "Marked build (missing run)",
              d2aBuildRunDir: path.join(tmp, "runs", "never-initialized"),
            },
            buildCtx("call-missing"),
          )
          expect(missing.metadata.exit).toBe(0)
          expect(missing.metadata.d2aWorkflowSnapshots).toBeUndefined()
        }),
      )
    }),
  )

  for (const item of ps) {
    it.live(`d2a: a failing PowerShell command that never sets $LASTEXITCODE is still a failed build [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const runDir = path.join(tmp, "runs", "run-1")
              yield* initRun(runDir)
              // Write-Error fails without ever touching $LASTEXITCODE: a
              // trailing `; exit $LASTEXITCODE` fix-up would exit 0 here and
              // record a false success. The -Command wrapper keeps the exit
              // non-zero, so the tracked boolean stays correct.
              const errored = yield* run(
                {
                  command: "Write-Error 'd2a marked build boom'",
                  description: "D2A marked build (PowerShell error)",
                  d2aBuildRunDir: runDir,
                },
                buildCtx("call-ps-error"),
              )
              expect(errored.metadata.exit).not.toBe(0)
              const observed = snapshots(errored)
              expect(observed).toHaveLength(1)
              expect(observed[0].buildResult).toMatchObject({ callId: "call-ps-error", success: false })
            }),
          )
        }),
      ),
    )
  }
})
