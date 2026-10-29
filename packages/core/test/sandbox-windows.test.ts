import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { SandboxRuntime } from "@bitfun-ai/sandbox"
import { BUILTIN_PROFILES } from "../src/config/sandbox"
import { toNativePrepareRequest } from "../src/sandbox"

const windows = process.platform === "win32" && process.arch === "x64"
const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe.skipIf(!windows)("Windows workspace sandbox", () => {
  it("prepares the local package and denies writes outside all workspace roots", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deveco-sandbox-"))
    const outsideRoot = mkdtempSync(path.join(os.homedir(), "deveco-sandbox-outside-"))
    roots.push(root, outsideRoot)
    const workspace = path.join(root, "workspace")
    const secondary = path.join(root, "secondary")
    const inside = path.join(workspace, "inside.txt")
    const secondaryFile = path.join(secondary, "secondary.txt")
    const outside = path.join(outsideRoot, "outside.txt")
    mkdirSync(workspace)
    mkdirSync(secondary)
    await Bun.write(path.join(workspace, ".keep"), "")
    const env = Object.fromEntries(
      ["PATH", "SystemRoot", "ComSpec", "TEMP", "TMP"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    )
    const profile = {
      profile_id: "workspace",
      filesystem: { ...BUILTIN_PROFILES.workspace.filesystem },
      network_enabled: true,
      workspace_roots: [workspace, secondary],
      is_implicit: false,
      source_layer: "project",
    } as const
    const runtime = SandboxRuntime.new({ state_dir: null, bundled_executables_dir: null })
    const request = toNativePrepareRequest(profile, {
      executable: process.execPath,
      args: [
        "-e",
        `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(inside)},"allowed");fs.writeFileSync(${JSON.stringify(secondaryFile)},"allowed");fs.writeFileSync(${JSON.stringify(outside)},"denied")`,
      ],
      cwd: workspace,
      env,
    })
    const support = await runtime.probe({
      file_system_context: request.file_system_context,
      permissions: request.permissions,
    })

    expect(support).toEqual({ type: "Supported" })
    const prepared = await runtime.prepare(request)
    const result = spawnSync(prepared.executable, prepared.args, {
      cwd: prepared.cwd,
      env: Object.fromEntries(prepared.env),
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    })
    if (!existsSync(inside)) {
      throw new Error(
        `sandbox launcher failed: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
      )
    }
    expect(result.status).not.toBe(0)
    expect(existsSync(inside)).toBe(true)
    expect(existsSync(secondaryFile)).toBe(true)
    expect(existsSync(outside)).toBe(false)
  }, 30_000)

  it("enforces additional read-only filesystem rules in workspace-derived profiles", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "deveco-sandbox-read-"))
    roots.push(workspace)
    const readOnly = path.join(workspace, "secrets")
    const writable = path.join(workspace, "writable.txt")
    const denied = path.join(readOnly, "denied.txt")
    mkdirSync(readOnly)
    const runtime = SandboxRuntime.new({ state_dir: null, bundled_executables_dir: null })
    const request = toNativePrepareRequest(
      {
        profile_id: "workspace-protected",
        filesystem: {
          ...BUILTIN_PROFILES.workspace.filesystem,
          ":workspace_roots/secrets": "read",
        },
        network_enabled: true,
        workspace_roots: [workspace],
        is_implicit: false,
        source_layer: "project",
      },
      {
        executable: process.execPath,
        args: [
          "-e",
          `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(writable)},"allowed");fs.writeFileSync(${JSON.stringify(denied)},"denied")`,
        ],
        cwd: workspace,
        env: {},
      },
    )

    const prepared = await runtime.prepare(request)
    const result = spawnSync(prepared.executable, prepared.args, {
      cwd: prepared.cwd,
      env: Object.fromEntries(prepared.env),
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    })

    expect(result.status).not.toBe(0)
    expect(existsSync(writable)).toBe(true)
    expect(existsSync(denied)).toBe(false)
  })
})
