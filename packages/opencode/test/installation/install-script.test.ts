import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const install = path.resolve(import.meta.dir, "../../../..", "install")

describe("bash install script", () => {
  test("help exits successfully before install directories are initialized", async () => {
    const proc = Bun.spawn(["bash", install, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("DevEco Code Installer")
    expect(stderr).not.toContain("unbound variable")
  })

  test("local binary install carries adjacent runtime resources atomically", async () => {
    await using tmp = await tmpdir()
    const artifact = path.join(tmp.path, "artifact")
    const binary = path.join(artifact, "bin", "deveco")
    const devecoCli = path.join(
      artifact,
      "vendor",
      "deveco-cli",
      "node_modules",
      "@deveco",
      "deveco-cli",
      "dist",
      "cli.js",
    )
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await fs.mkdir(path.join(artifact, "vendor", "fixture"), { recursive: true })
    await fs.mkdir(path.dirname(devecoCli), { recursive: true })
    await Bun.write(binary, '#!/bin/sh\n[ "$1" = "--version" ] && echo local-test\n')
    await fs.chmod(binary, 0o755)
    await Bun.write(devecoCli, "console.log('deveco-cli')\n")
    await Bun.write(path.join(artifact, "vendor", "fixture", "runtime.txt"), "runtime\n")
    await Bun.write(path.join(artifact, "CHANGELOG.md"), "# Changes\n")

    const proc = Bun.spawn(["bash", install, "--binary", binary, "--no-modify-path"], {
      env: {
        ...process.env,
        HOME: tmp.path,
        XDG_DATA_HOME: path.join(tmp.path, ".local", "share"),
        SHELL: "/bin/zsh",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited])
    expect(exitCode, stderr).toBe(0)

    const root = path.join(tmp.path, ".local", "share", "deveco", "versions", "local-test")
    expect(await fs.readFile(path.join(root, "vendor", "fixture", "runtime.txt"), "utf8")).toBe("runtime\n")
    expect(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8")).toBe("# Changes\n")
    expect(await fs.realpath(path.join(tmp.path, ".local", "bin", "deveco"))).toBe(path.join(root, "bin", "deveco"))
  })

  test("rejects non-macOS hosts before installing", async () => {
    await using tmp = await tmpdir()
    const fakeBin = path.join(tmp.path, "bin")
    const uname = path.join(fakeBin, "uname")
    await fs.mkdir(fakeBin, { recursive: true })
    await Bun.write(uname, "#!/bin/sh\necho Linux\n")
    await fs.chmod(uname, 0o755)

    const proc = Bun.spawn(["bash", install, "--no-modify-path"], {
      env: { ...process.env, HOME: tmp.path, PATH: `${fakeBin}:${process.env.PATH}`, SHELL: "/bin/zsh" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited])

    expect(exitCode).toBe(1)
    expect(stderr).toContain("This installer supports macOS only")
  })

  test("rejects a local build without the bundled deveco-cli runtime", async () => {
    await using tmp = await tmpdir()
    const artifact = path.join(tmp.path, "artifact")
    const binary = path.join(artifact, "bin", "deveco")
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await Bun.write(binary, '#!/bin/sh\n[ "$1" = "--version" ] && echo local-test\n')
    await fs.chmod(binary, 0o755)
    await Bun.write(path.join(artifact, "CHANGELOG.md"), "# Changes\n")

    const proc = Bun.spawn(["bash", install, "--binary", binary, "--no-modify-path"], {
      env: {
        ...process.env,
        HOME: tmp.path,
        XDG_DATA_HOME: path.join(tmp.path, ".local", "share"),
        SHELL: "/bin/zsh",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited])

    expect(exitCode).toBe(1)
    expect(stderr).toContain("complete build output containing vendor/deveco-cli")
  })

  test("installs successfully and warns when Node.js is older than the deveco-cli requirement", async () => {
    await using tmp = await tmpdir()
    const fakeBin = path.join(tmp.path, "bin")
    const node = path.join(fakeBin, "node")
    const artifact = path.join(tmp.path, "artifact")
    const binary = path.join(artifact, "bin", "deveco")
    const devecoCli = path.join(
      artifact,
      "vendor",
      "deveco-cli",
      "node_modules",
      "@deveco",
      "deveco-cli",
      "dist",
      "cli.js",
    )
    await fs.mkdir(fakeBin, { recursive: true })
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await fs.mkdir(path.dirname(devecoCli), { recursive: true })
    await Bun.write(node, "#!/bin/sh\necho v16.20.0\n")
    await fs.chmod(node, 0o755)
    await Bun.write(binary, '#!/bin/sh\n[ "$1" = "--version" ] && echo local-test\n')
    await fs.chmod(binary, 0o755)
    await Bun.write(devecoCli, "console.log('deveco-cli')\n")
    await Bun.write(path.join(artifact, "CHANGELOG.md"), "# Changes\n")

    const proc = Bun.spawn(["bash", install, "--binary", binary, "--no-modify-path"], {
      env: {
        ...process.env,
        HOME: tmp.path,
        XDG_DATA_HOME: path.join(tmp.path, ".local", "share"),
        PATH: `${fakeBin}:${process.env.PATH}`,
        SHELL: "/bin/zsh",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stdout), proc.exited])

    expect(exitCode).toBe(0)
    expect(stdout).toContain(
      'WARNING: Node.js 22 or later is required. Without it, some DevEco Code features will not work. Install Node.js from https://nodejs.org/ and make sure "node" is available in your PATH.',
    )
  })
})
