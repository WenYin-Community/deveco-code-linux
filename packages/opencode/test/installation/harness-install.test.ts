import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const repo = path.resolve(import.meta.dir, "../../../..")
const shells =
  process.platform === "win32"
    ? [...new Set([Bun.which("pwsh"), Bun.which("powershell.exe")].filter((value): value is string => !!value))]
    : []
const powershell = shells[0]
const git = Bun.which("git")
const bash =
  process.platform === "win32" ? git && path.resolve(path.dirname(git), "../bin/bash.exe") : Bun.which("bash")
const hasBash = bash && (await Bun.file(bash).exists())

async function run(command: string[], env = process.env, cwd?: string) {
  const proc = Bun.spawn(command, { env, cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

async function dependency(root: string) {
  const pkg = path.join(root, "package")
  await Bun.write(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "@deveco-test/deveco-harness",
      version: "0.0.0",
      exports: { "./server": "./index.js" },
    }),
  )
  await Bun.write(path.join(pkg, "index.js"), "module.exports = { installed: true }")
  const archive = path.join(root, "harness.tgz")
  const result = await run(["tar", "-czf", archive, "-C", root, "package"])
  expect(result.code, result.stderr).toBe(0)
  return `file:${archive.replaceAll("\\", "/")}`
}

async function zip(root: string, output: string) {
  const command = powershell
    ? [
        powershell,
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${root.replaceAll("'", "''")}', '${output.replaceAll("'", "''")}')`,
      ]
    : ["zip", "-qr", output, "."]
  const result = await run(command, process.env, root)
  expect(result.code, result.stderr).toBe(0)
}

describe("archive installer Harness dependencies", () => {
  test.skipIf(!hasBash || (!powershell && !Bun.which("zip")))(
    "curl installs and repairs dependencies before switching the symlink",
    async () => {
      await using tmp = await tmpdir()
      const spec = await dependency(tmp.path)
      const artifact = path.join(tmp.path, "artifact")
      const fakeBin = path.join(tmp.path, "commands")
      await Bun.write(path.join(fakeBin, "uname"), '#!/bin/sh\ncase "$1" in -m) echo arm64;; *) echo Darwin;; esac\n')
      await fs.chmod(path.join(fakeBin, "uname"), 0o755)
      const makeArchive = async (version: string, dependency: string) => {
        await Bun.write(path.join(artifact, "bin/deveco"), `#!/bin/sh\necho ${version}\n`)
        await Bun.write(
          path.join(artifact, "package.json"),
          JSON.stringify({
            name: "deveco-fixture",
            version,
            private: true,
            os: ["darwin"],
            cpu: ["arm64"],
            dependencies: { "@deveco-test/deveco-harness": dependency },
          }),
        )
        const output = path.join(tmp.path, `${version}.zip`)
        await zip(artifact, output)
        return output
      }
      let archive = await makeArchive("harness-test-1", spec)
      let downloads = 0
      using server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
          if (new URL(request.url).pathname.endsWith("/download")) {
            downloads++
            return new Response(Bun.file(archive))
          }
          return Response.json({})
        },
      })
      const script = path.join(tmp.path, "install")
      await Bun.write(
        script,
        (await fs.readFile(path.join(repo, "install"), "utf8"))
          .replaceAll("\r\n", "\n")
          .replace(/^GITCODE_API=.*$/m, `GITCODE_API="${server.url.origin}/fixture"`),
      )
      const env = {
        ...process.env,
        HOME: tmp.path.replaceAll("\\", "/"),
        XDG_DATA_HOME: path.join(tmp.path, "data with spaces").replaceAll("\\", "/"),
        PATH: [
          fakeBin,
          process.platform === "win32" ? path.resolve(path.dirname(bash!), "../usr/bin") : "/usr/bin",
          process.env.PATH,
        ].join(path.delimiter),
        SHELL: "/bin/bash",
        MSYS: "winsymlinks:sys",
        DEVECO_TELEMETRY_DISABLED: "1",
      }
      const install = (version: string) =>
        run(
          [bash!, "--noprofile", "--norc", script.replaceAll("\\", "/"), "--version", version, "--no-modify-path"],
          env,
        )
      const first = await install("harness-test-1")
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0)
      const root = path.join(tmp.path, "data with spaces/deveco/versions/harness-test-1")
      const entry = path.join(root, "node_modules/@deveco-test/deveco-harness/index.js")
      expect(await Bun.file(entry).exists()).toBe(true)
      expect(await Bun.file(path.join(root, "vendor/harness/package.json")).exists()).toBe(false)
      // Re-running an installed release must repair an absent dependency.
      expect(entry.startsWith(tmp.path + path.sep)).toBe(true)
      await fs.rm(path.dirname(entry), { recursive: true, force: true })
      const repair = await install("harness-test-1")
      expect(repair.code, repair.stderr).toBe(0)
      expect(await Bun.file(entry).exists()).toBe(true)
      expect(downloads).toBe(1)
      archive = await makeArchive("harness-test-2", `file:${path.join(tmp.path, "missing.tgz").replaceAll("\\", "/")}`)
      const failed = await install("harness-test-2")
      expect(failed.code).not.toBe(0)
      const link = await run(
        [bash!, "-c", 'readlink "$1"', "bash", path.join(tmp.path, ".local/bin/deveco").replaceAll("\\", "/")],
        env,
      )
      expect(link.stdout.trim().replaceAll("\\", "/")).toContain("versions/harness-test-1/bin/deveco")
      expect(await Bun.file(entry).exists()).toBe(true)
    },
    60_000,
  )

  test.each(shells)(
    "irm installs archive dependencies, repairs them, and preserves the launcher when npm fails (%s)",
    async (shell) => {
      await using tmp = await tmpdir()
      const spec = await dependency(tmp.path)
      const artifact = path.join(tmp.path, "artifact")
      const binary = path.join(artifact, "bin/deveco.exe")
      await fs.mkdir(path.dirname(binary), { recursive: true })
      await fs.copyFile(process.execPath, binary)
      const manifest = {
        name: "deveco-fixture",
        version: Bun.version,
        private: true,
        dependencies: { "@deveco-test/deveco-harness": spec },
      }
      await Bun.write(path.join(artifact, "package.json"), JSON.stringify(manifest))
      const archive = path.join(tmp.path, "release.zip")
      await zip(artifact, archive)
      let downloads = 0
      using server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
          if (new URL(request.url).pathname.endsWith("/download")) {
            downloads++
            return new Response(Bun.file(archive))
          }
          return Response.json({})
        },
      })
      const script = path.join(tmp.path, "install.ps1")
      await Bun.write(
        script,
        (await fs.readFile(path.join(repo, "install.ps1"), "utf8")).replace(
          /^\$GitCodeApi =.*$/m,
          `$GitCodeApi = "${server.url.origin}/fixture"`,
        ),
      )
      const env = {
        ...process.env,
        USERPROFILE: path.join(tmp.path, "installed profile"),
        XDG_DATA_HOME: path.join(tmp.path, "data with spaces"),
        DEVECO_TELEMETRY_DISABLED: "1",
      }
      const install = (args: string[]) =>
        run([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args, "-NoModifyPath"], env)
      const first = await install(["-Version", Bun.version, "-Baseline"])
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0)
      const root = path.join(tmp.path, "data with spaces/deveco/versions", Bun.version)
      const entry = path.join(root, "node_modules/@deveco-test/deveco-harness/index.js")
      expect(await Bun.file(entry).exists()).toBe(true)
      expect(entry.startsWith(tmp.path + path.sep)).toBe(true)
      await fs.rm(path.dirname(entry), { recursive: true, force: true })
      const repair = await install(["-Version", Bun.version, "-Baseline"])
      expect(repair.code, repair.stderr).toBe(0)
      expect(await Bun.file(entry).exists()).toBe(true)
      expect(downloads).toBe(1)
      const launcher = path.join(tmp.path, "installed profile/.local/bin/deveco.exe")
      const before = new Bun.CryptoHasher("sha256").update(await Bun.file(launcher).arrayBuffer()).digest("hex")
      await Bun.write(
        path.join(artifact, "package.json"),
        JSON.stringify({
          ...manifest,
          dependencies: {
            "@deveco-test/deveco-harness": `file:${path.join(tmp.path, "missing.tgz").replaceAll("\\", "/")}`,
          },
        }),
      )
      const failed = await install(["-Binary", binary])
      expect(failed.code).not.toBe(0)
      expect(new Bun.CryptoHasher("sha256").update(await Bun.file(launcher).arrayBuffer()).digest("hex")).toBe(before)
      expect(await Bun.file(entry).exists()).toBe(true)
      expect((await Bun.file(path.join(root, "package.json")).json()).dependencies["@deveco-test/deveco-harness"]).toBe(
        spec,
      )
    },
    60_000,
  )
})
