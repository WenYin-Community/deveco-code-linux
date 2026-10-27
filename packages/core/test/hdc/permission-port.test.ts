import { describe, expect, it } from "bun:test"
import {
  mapToPermissionAction,
  mapToPermissionResource,
} from "../../src/hdc/permission-port"
import type { HdcOperation } from "../../src/hdc/operation"

// ─── SEC2-006: 系统 Permission 映射与适配 ──────────────────

const mk = (op: Partial<HdcOperation> & { kind: string }): HdcOperation => op as HdcOperation
const devTarget = { selection: "explicit" as const, displayLabel: "dev1", permissionResource: "device:123" }
const noTarget = { selection: "not_applicable" as const }

describe("SEC2-006: action mapping (§2)", () => {
  // 验证: 17 种 operation.kind 全部映射到预期的 Permission action 字符串 (hdc:shell/hdc:install 等)
  const cases: { kind: string; op: HdcOperation; expected: string }[] = [
    { kind: "versionOrHelp", op: mk({ kind: "versionOrHelp" }), expected: "hdc:query" },
    { kind: "listTargets", op: mk({ kind: "listTargets" }), expected: "hdc:query" },
    { kind: "discover", op: mk({ kind: "discover" }), expected: "hdc:query" },
    { kind: "shell", op: mk({ kind: "shell", deviceArgv: ["ls"], interactive: false }), expected: "hdc:shell" },
    { kind: "hilog", op: mk({ kind: "hilog", args: [] }), expected: "hdc:hilog" },
    { kind: "install", op: mk({ kind: "install", packagePath: "/app.hap" }), expected: "hdc:install" },
    { kind: "fileSend", op: mk({ kind: "fileSend", localPath: "/l", remotePath: "/r" }), expected: "hdc:file:send" },
    { kind: "fileRecv", op: mk({ kind: "fileRecv", remotePath: "/r", localPath: "/l" }), expected: "hdc:file:recv" },
    { kind: "uninstall", op: mk({ kind: "uninstall", bundleName: "com.example" }), expected: "hdc:uninstall" },
    { kind: "appControl", op: mk({ kind: "appControl", action: "aa start" }), expected: "hdc:app:control" },
    { kind: "bugreport", op: mk({ kind: "bugreport", localPath: undefined }), expected: "hdc:bugreport" },
    { kind: "transportConnect", op: mk({ kind: "transportConnect", endpoint: "127.0.0.1:8080" }), expected: "hdc:tconn" },
    { kind: "portForward", op: mk({ kind: "portForward", direction: "forward", args: [] }), expected: "hdc:fport" },
    { kind: "modeOrDaemon", op: mk({ kind: "modeOrDaemon", action: "smode" }), expected: "hdc:mode" },
    { kind: "rebootOrBoot", op: mk({ kind: "rebootOrBoot" }), expected: "hdc:reboot" },
    { kind: "firmwareMutation", op: mk({ kind: "firmwareMutation", command: "mount" }), expected: "hdc:firmware" },
    { kind: "unclassified", op: mk({ kind: "unclassified", originalArgv: ["x"] }), expected: "hdc:unclassified" },
  ]

  for (const c of cases) {
    it(`${c.kind} → action=${c.expected}`, () => {
      expect(mapToPermissionAction(c.op)).toBe(c.expected)
    })
  }
})

describe("SEC2-006: resource mapping (§3)", () => {
  // 验证: install resource 包含 device ID 和 package path (device:123 + package:/app.hap)
  it("install resource includes device + package path", () => {
    const op = mk({ kind: "install", packagePath: "/app.hap" })
    const resource = mapToPermissionResource(op, devTarget)
    expect(resource).toContain("device:123")
    expect(resource).toContain("package:/app.hap")
  })

  // 验证: fileSend resource 包含 device ID 和 remote path (设备端路径标识)
  it("fileSend resource includes device + remote path", () => {
    const op = mk({ kind: "fileSend", localPath: "/local", remotePath: "/data/local/tmp/r" })
    const resource = mapToPermissionResource(op, devTarget)
    expect(resource).toContain("device:123")
    expect(resource).toContain("path:/data/local/tmp/r")
  })

  // 验证: 非设备操作 (versionOrHelp) resource 使用 * (无具体资源)
  it("non-device operation resource uses *", () => {
    const op = mk({ kind: "versionOrHelp" })
    const resource = mapToPermissionResource(op, noTarget)
    expect(resource).toContain("*")
  })

  // 验证: resource 字符串不包含 token/password/secret/key 等敏感字段 (安全要求)
  it("resource does not contain token or credentials (§3)", () => {
    const op = mk({ kind: "install", packagePath: "/app.hap" })
    const resource = mapToPermissionResource(op, devTarget)
    expect(resource).not.toContain("token")
    expect(resource).not.toContain("password")
    expect(resource).not.toContain("secret")
    expect(resource).not.toContain("key")
  })

  // 验证: uninstall resource 包含 device ID 和 bundle name
  it("uninstall resource includes device + bundle", () => {
    const op = mk({ kind: "uninstall", bundleName: "com.example.app" })
    const resource = mapToPermissionResource(op, devTarget)
    expect(resource).toContain("device:123")
    expect(resource).toContain("bundle:com.example.app")
  })

  // 验证: transportConnect resource 包含 endpoint (非设备操作)
  it("transportConnect resource includes endpoint", () => {
    const op = mk({ kind: "transportConnect", endpoint: "127.0.0.1:8080" })
    const resource = mapToPermissionResource(op, noTarget)
    expect(resource).toContain("endpoint:127.0.0.1:8080")
  })

  // 验证: shell resource 包含 device ID 和命令前缀 (cmd:getprop)
  it("shell resource includes device + command", () => {
    const op = mk({ kind: "shell", deviceArgv: ["getprop", "ro.build"], interactive: false })
    const resource = mapToPermissionResource(op, devTarget)
    expect(resource).toContain("device:123")
    expect(resource).toContain("cmd:getprop")
  })
})
