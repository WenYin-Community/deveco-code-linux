import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/fixture"
import { COMMIT, interpreterReady, ready } from "../resources/skills/hmos-design-to-arkts/scripts/lanhu-setup.mjs"

const PATCH = await Bun.file(
  new URL("../resources/skills/hmos-design-to-arkts/scripts/lanhu-mastergo.patch.json", import.meta.url),
).json()
const unix = process.platform !== "win32"
const interpreter = unix ? "python" : "python.exe"
const previous = {
  UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
}

afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

// Mirror the uv layout: a managed CPython tree under the python install dir.
async function uvInterpreter(uvRoot: string) {
  const managed = path.join(uvRoot, "cpython-3.12.12-macos-aarch64-none", "bin", unix ? "python3.12" : interpreter)
  await fs.mkdir(path.dirname(managed), { recursive: true })
  await fs.writeFile(managed, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  await fs.chmod(uvRoot, 0o700)
  return managed
}

async function venvPython(root: string) {
  const python = path.join(root, "runtime", "venv", unix ? "bin" : "Scripts", interpreter)
  await fs.mkdir(path.dirname(python), { recursive: true })
  return python
}

describe("interpreterReady", () => {
  test("accepts a regular file interpreter", async () => {
    await using tmp = await tmpdir()
    const python = await venvPython(tmp.path)
    await fs.writeFile(python, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    expect(await interpreterReady(python)).toBe(true)
  })

  test("reports a missing interpreter as unready", async () => {
    await using tmp = await tmpdir()
    expect(await interpreterReady(await venvPython(tmp.path))).toBe(false)
  })

  test.skipIf(!unix)("accepts a symlink to the uv managed interpreter", async () => {
    await using tmp = await tmpdir()
    const uvRoot = path.join(tmp.path, "uv", "python")
    process.env.UV_PYTHON_INSTALL_DIR = uvRoot
    const python = await venvPython(tmp.path)
    await fs.symlink(await uvInterpreter(uvRoot), python)
    expect(await interpreterReady(python)).toBe(true)
  })

  test.skipIf(!unix)("rejects a symlink to a directory inside the uv python root", async () => {
    await using tmp = await tmpdir()
    const uvRoot = path.join(tmp.path, "uv", "python")
    process.env.UV_PYTHON_INSTALL_DIR = uvRoot
    const python = await venvPython(tmp.path)
    await fs.symlink(path.dirname(path.dirname(await uvInterpreter(uvRoot))), python)
    expect(await interpreterReady(python)).toBe(false)
  })

  test.skipIf(!unix)("rejects a symlink outside the uv python root", async () => {
    await using tmp = await tmpdir()
    const uvRoot = path.join(tmp.path, "uv", "python")
    process.env.UV_PYTHON_INSTALL_DIR = uvRoot
    await uvInterpreter(uvRoot)
    const outside = path.join(tmp.path, "outside", "python")
    await fs.mkdir(path.dirname(outside), { recursive: true })
    await fs.writeFile(outside, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const python = await venvPython(tmp.path)
    await fs.symlink(outside, python)
    expect(await interpreterReady(python)).toBe(false)
  })

  test.skipIf(!unix)("rejects a symlink to an interpreter in another uv python root", async () => {
    await using tmp = await tmpdir()
    const uvRoot = path.join(tmp.path, "uv", "python")
    process.env.UV_PYTHON_INSTALL_DIR = path.join(tmp.path, "other", "python")
    await fs.mkdir(process.env.UV_PYTHON_INSTALL_DIR, { recursive: true })
    const python = await venvPython(tmp.path)
    await fs.symlink(await uvInterpreter(uvRoot), python)
    expect(await interpreterReady(python)).toBe(false)
  })

  test.skipIf(!unix)("rejects a symlink whose target escapes through a symlinked ancestor", async () => {
    await using tmp = await tmpdir()
    const uvRoot = path.join(tmp.path, "uv", "python")
    process.env.UV_PYTHON_INSTALL_DIR = uvRoot
    await uvInterpreter(uvRoot)
    const outside = path.join(tmp.path, "outside", "bin", "python3.12")
    await fs.mkdir(path.dirname(outside), { recursive: true })
    await fs.writeFile(outside, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    await fs.symlink(path.join(tmp.path, "outside"), path.join(tmp.path, "alias"))
    const python = await venvPython(tmp.path)
    await fs.symlink(path.join(tmp.path, "alias", "bin", "python3.12"), python)
    // The link target canonicalizes outside the allowlist root, so the realpath
    // comparison rejects it; it never reaches the ancestor symlink check.
    expect(await interpreterReady(python)).toBe(false)
  })

  test.skipIf(!unix)("accepts a managed interpreter when XDG_DATA_HOME is a symlink", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const link = path.join(tmp.path, "data-link")
    await fs.mkdir(data)
    await fs.symlink(data, link)
    delete process.env.UV_PYTHON_INSTALL_DIR
    process.env.XDG_DATA_HOME = link
    const python = await venvPython(tmp.path)
    await fs.symlink(await uvInterpreter(path.join(link, "uv", "python")), python)
    expect(await interpreterReady(python)).toBe(true)
  })

  test.skipIf(!unix)("rejects a uv python root writable by other users", async () => {
    await using tmp = await tmpdir()
    const uvRoot = path.join(tmp.path, "uv", "python")
    process.env.UV_PYTHON_INSTALL_DIR = uvRoot
    const python = await venvPython(tmp.path)
    await fs.symlink(await uvInterpreter(uvRoot), python)
    await fs.chmod(uvRoot, 0o770)
    expect(await interpreterReady(python)).toBe(false)
  })
})

describe("ready", () => {
  test.skipIf(!unix)("reports an unready installation instead of throwing on an escaping interpreter", async () => {
    await using tmp = await tmpdir()
    const uvRoot = path.join(tmp.path, "uv", "python")
    process.env.UV_PYTHON_INSTALL_DIR = uvRoot
    await uvInterpreter(uvRoot)
    const outside = path.join(tmp.path, "outside", "python")
    await fs.mkdir(path.dirname(outside), { recursive: true })
    await fs.writeFile(outside, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const python = await venvPython(tmp.path)
    await fs.symlink(outside, python)
    const receipt = path.join(tmp.path, "runtime", "installation.json")
    await fs.writeFile(receipt, JSON.stringify({ commit: COMMIT, patch: PATCH.id }))
    const target = { receipt, python, source: path.join(tmp.path, "runtime", "source") }
    // The recorded bug threw here; a stale installation has to read as unready instead.
    expect(await ready(target).catch(() => "threw")).toBe(false)
  })
})
