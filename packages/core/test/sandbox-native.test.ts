import { describe, expect, it } from "bun:test"
import os from "node:os"
import { BUILTIN_PROFILES } from "../src/config/sandbox"
import { toNativePrepareRequest } from "../src/sandbox"

describe("sandbox native request", () => {
  it("includes Windows-compatible process, network, and temporary directory policies", () => {
    const request = toNativePrepareRequest(
      {
        profile_id: "workspace",
        filesystem: {
          ":root": "read",
          ":workspace_roots": "write",
          ":workspace_roots/secrets": "read",
        },
        network_enabled: true,
        workspace_roots: ["C:\\workspace", "D:\\shared"],
        is_implicit: false,
        source_layer: "project",
      },
      {
        executable: "C:\\Windows\\System32\\cmd.exe",
        args: ["/c", "echo test"],
        cwd: "C:\\workspace",
        env: { SystemRoot: "C:\\Windows" },
      },
    )

    expect(request.permissions).toMatchObject({
      type: "Managed",
      network: { type: "Enabled" },
      process: { type: "AllowAll" },
    })
    expect(request.file_system_context.workspace_roots).toEqual(["C:\\workspace", "D:\\shared"])
    expect(request.file_system_context.temporary_directories).toEqual([os.tmpdir()])
    if (request.permissions.type !== "Managed") throw new Error("expected managed permissions")
    expect(request.permissions.file_system.entries).toContainEqual({
      path: { type: "Special", value: { type: "ProjectRoots", subpath: "secrets" } },
      access: { type: "Read" },
      missing_path_behavior: { type: "Skip" },
    })
  })

  it("encodes workspace subpath reads without duplicating protected path names", () => {
    const request = toNativePrepareRequest(
      {
        profile_id: "workspace",
        filesystem: { ...BUILTIN_PROFILES.workspace.filesystem },
        network_enabled: true,
        workspace_roots: ["C:\\workspace"],
        is_implicit: false,
        source_layer: "project",
      },
      { executable: "cmd.exe", args: ["/c", "exit 0"], cwd: "C:\\workspace", env: {} },
    )

    if (request.permissions.type !== "Managed") throw new Error("expected managed permissions")
    expect(request.permissions.file_system.entries).toContainEqual({
      path: { type: "Special", value: { type: "ProjectRoots", subpath: ".git" } },
      access: { type: "Read" },
      missing_path_behavior: { type: "Skip" },
    })
  })

  it.skipIf(process.platform !== "win32")("normalizes case-insensitive Windows environment keys", () => {
    const request = toNativePrepareRequest(
      {
        profile_id: "workspace",
        filesystem: { ":root": "read", ":workspace_roots": "write" },
        network_enabled: true,
        workspace_roots: ["C:\\workspace"],
        is_implicit: false,
        source_layer: "project",
      },
      {
        executable: "C:\\Windows\\System32\\cmd.exe",
        args: ["/c", "echo test"],
        cwd: "C:\\workspace",
        env: { Path: "system", PATH: "plugin" },
      },
    )

    expect(request.command.env).toEqual([["PATH", "plugin"]])
  })
})
