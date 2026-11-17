import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("npm postinstall installs host resources without a direct CLI dependency or entry marker", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "npm host with spaces")
  const platform = process.platform === "win32" ? "windows" : process.platform
  const name = `@deveco/deveco-code-${platform}-${process.arch}`
  const native = path.join(root, "node_modules", ...name.split("/"))
  const binary = path.join(native, "bin", process.platform === "win32" ? "deveco.exe" : "deveco")
  await fs.mkdir(path.dirname(binary), { recursive: true })
  await fs.copyFile(process.execPath, binary)
  await Bun.write(path.join(native, "package.json"), JSON.stringify({ name, version: "1.0.0" }))
  await Bun.write(path.join(native, "vendor", "fixture", "resource.txt"), "host resource")
  await Bun.write(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@deveco/deveco-code",
      version: "1.0.0",
      optionalDependencies: { [name]: "1.0.0" },
    }),
  )
  await fs.copyFile(path.resolve(import.meta.dir, "../../script/postinstall.mjs"), path.join(root, "postinstall.mjs"))
  const child = Bun.spawn([process.execPath, path.join(root, "postinstall.mjs")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  })
  const [code, stderr] = await Promise.all([child.exited, Bun.readableStreamToText(child.stderr)])
  expect(code, stderr).toBe(0)
  expect(await Bun.file(path.join(root, "bin", "deveco.exe")).exists()).toBe(true)
  expect(await Bun.file(path.join(root, "vendor", "fixture", "resource.txt")).text()).toBe("host resource")
  expect(await Bun.file(path.join(root, "vendor", ".deveco-cli-entry")).exists()).toBe(false)
})
