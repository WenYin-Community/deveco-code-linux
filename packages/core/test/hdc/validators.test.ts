import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  validateLocalInput,
  validateLocalOutput,
  validateDevicePath,
  validateEndpoint,
  validatePort,
  validateBundle,
  validateTargetDevice,
  validateOperation,
  validateParamName,
  type ValidationContext,
} from "../../src/hdc/validators"
import type { HdcOperation } from "../../src/hdc/operation"
import type { HdcGuardTrustedContext } from "../../src/hdc/decision"

// ─── SEC2-002: 可信对象与目标设备校验 ──────────────────────

// 构造一个最小的 store-only zip 包（method 0），内含 module.json。
// 用于 install 的 hap bundle 身份校验测试（与 readHapBundleName 配合）。
function makeFakeHap(bundleName: string): Buffer {
  const moduleJson = Buffer.from(`{ "app": { "bundleName": "${bundleName}" } }`, "utf8")
  const name = Buffer.from("module.json", "utf8")

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt16LE(moduleJson.length, 18)
  local.writeUInt16LE(moduleJson.length, 22)
  local.writeUInt16LE(name.length, 26)

  const localOffset = 0
  const localData = Buffer.concat([local, name, moduleJson])

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt16LE(moduleJson.length, 20)
  central.writeUInt16LE(moduleJson.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(localOffset, 42)

  const centralData = Buffer.concat([central, name])
  const cdOffset = localData.length

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt16LE(1, 12)
  eocd.writeUInt32LE(centralData.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)


  return Buffer.concat([localData, centralData, eocd])
}

// 创建临时 workspace 目录用于文件类型/可创建性校验测试
let tmpWorkspace: string
let tmpFile: string

beforeEach(() => {
  tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "hdc-test-"))
  tmpFile = path.join(tmpWorkspace, "app.hap")
  fs.writeFileSync(tmpFile, "fake hap content")
})

afterEach(() => {
  fs.rmSync(tmpWorkspace, { recursive: true, force: true })
})

// 检测当前进程是否有创建符号链接的权限 (Windows 非 admin / 未开启 Developer Mode 时无法创建)
let canCreateSymlinks: boolean
try {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hdc-symlink-probe-"))
  const probeTarget = path.join(probeDir, "target.txt")
  const probeLink = path.join(probeDir, "link.txt")
  fs.writeFileSync(probeTarget, "probe")
  fs.symlinkSync(probeTarget, probeLink, "file")
  fs.rmSync(probeDir, { recursive: true, force: true })
  canCreateSymlinks = true
} catch {
  canCreateSymlinks = false
}

const ctx: ValidationContext = {
  cwd: "/workspace/project",
  workspaceRoot: "/workspace",
  targetDevice: { selection: "explicit", displayLabel: "device-1", permissionResource: "device:123" },
  projectBundles: ["com.example.app"],
}

const noDevCtx: ValidationContext = {
  cwd: "/workspace/project",
  workspaceRoot: "/workspace",
  targetDevice: { selection: "not_applicable" },
  projectBundles: ["com.example.app"],
}

// 使用临时目录的 context (用于文件类型/可创建性校验测试)
const tmpCtx = (): ValidationContext => ({
  cwd: tmpWorkspace,
  workspaceRoot: tmpWorkspace,
  targetDevice: { selection: "explicit", displayLabel: "device-1", permissionResource: "device:123" },
  projectBundles: ["com.example.app"],
})

describe("SEC2-002: Local path validators (§1)", () => {
  // 验证: install 本地路径在 workspace 内且为真实普通文件时通过校验
  it("install local path in workspace passes (with real file)", () => {
    const result = validateLocalInput(tmpFile, tmpCtx())
    expect(result._tag).toBe("valid")
  })

  // 验证: install 本地路径越出 workspace 时被拒绝 (local_path_denied)
  it("install local path outside workspace rejected", () => {
    const result = validateLocalInput("/tmp/app.hap", ctx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("local_path_denied")
    }
  })

  // 验证: file send 本地路径越出 workspace 时被拒绝 (例如读取 /etc/passwd)
  it("file send local path outside workspace rejected", () => {
    const result = validateLocalInput("/etc/passwd", ctx)
    expect(result._tag).toBe("invalid")
  })

  // 验证: file recv 输出路径越出 workspace 时被拒绝 (防止写入外部位置)
  it("file recv output path outside workspace rejected", () => {
    const result = validateLocalOutput("/tmp/output.txt", ctx)
    expect(result._tag).toBe("invalid")
  })

  // 验证: file recv 输出路径含 .. 路径穿越时被拒绝
  it("file recv output path with traversal rejected", () => {
    const result = validateLocalOutput("/workspace/../../../etc/passwd", ctx)
    expect(result._tag).toBe("invalid")
  })

  // 验证: 相对路径基于 cwd 解析, 在 workspace 内通过校验
  it("relative path resolved against cwd (with real file)", () => {
    const result = validateLocalInput("app.hap", tmpCtx())
    expect(result._tag).toBe("valid")
  })
})

// ─── SEC2-002 §1: 文件类型校验（specs §2.5.3 "普通文件类型"）──
describe("SEC2-002: Local input file type validation (specs §2.5.3)", () => {
  // 验证: workspace 内的普通文件通过文件类型校验
  it("regular file in workspace passes", () => {
    const result = validateLocalInput(tmpFile, tmpCtx())
    expect(result._tag).toBe("valid")
  })

  // 验证: 不存在的路径被拒绝 (防止 TOCTOU: 校验时不存在, 后续 spawn 时被恶意创建)
  it("non-existent path rejected", () => {
    const result = validateLocalInput(path.join(tmpWorkspace, "nonexistent.hap"), tmpCtx())
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("local_path_denied")
    }
  })

  // 验证: 目录路径被拒绝 (必须为普通文件, 防止将目录当作 hap 包)
  it("directory path rejected (not a regular file)", () => {
    const result = validateLocalInput(tmpWorkspace, tmpCtx())
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("local_path_denied")
      expect(result.detail).toContain("not a regular file")
    }
  })

  // 验证: 符号链接被拒绝 (防止通过 symlink 绕过 workspace 边界)
  it.skipIf(!canCreateSymlinks)("symbolic link rejected", () => {
    const linkPath = path.join(tmpWorkspace, "link.hap")
    fs.symlinkSync(tmpFile, linkPath, "file")
    const result = validateLocalInput(linkPath, tmpCtx())
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("local_path_denied")
      expect(result.detail).toContain("symbolic link")
    }
  })
})

// ─── SEC2-002 §1: 输出路径可创建性校验（specs §2.5.3）──
describe("SEC2-002: Local output creatability validation (specs §2.5.3)", () => {
  // 验证: 输出路径在可写 workspace 内时通过校验
  it("output path in writable workspace passes", () => {
    const result = validateLocalOutput(path.join(tmpWorkspace, "output.txt"), tmpCtx())
    expect(result._tag).toBe("valid")
  })

  // 验证: 输出路径的父目录不存在时被拒绝 (无法创建文件)
  it("output path with non-existent parent directory rejected", () => {
    const result = validateLocalOutput(path.join(tmpWorkspace, "nonexistent", "output.txt"), tmpCtx())
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("local_path_denied")
    }
  })

  // 验证: 输出路径本身是符号链接时被拒绝 (防止通过 symlink 重定向写入到外部位置)
  it.skipIf(!canCreateSymlinks)("output path that is a symlink rejected", () => {
    const realFile = path.join(tmpWorkspace, "real.txt")
    fs.writeFileSync(realFile, "real")
    const linkPath = path.join(tmpWorkspace, "link-output.txt")
    fs.symlinkSync(realFile, linkPath, "file")
    const result = validateLocalOutput(linkPath, tmpCtx())
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("local_path_denied")
      expect(result.detail).toContain("symbolic link")
    }
  })

  // 验证: 已存在的普通文件作为输出路径通过校验 (允许覆盖写入)
  it("existing regular file as output path passes (overwrite allowed)", () => {
    const existingFile = path.join(tmpWorkspace, "existing.txt")
    fs.writeFileSync(existingFile, "existing content")
    const result = validateLocalOutput(existingFile, tmpCtx())
    expect(result._tag).toBe("valid")
  })
})

describe("SEC2-002: Device path validators (§3)", () => {
  // 验证: 设备端 /data/ 路径在 allowlist 内通过校验
  it("/data/ path in allowlist passes", () => {
    expect(validateDevicePath("/data/local/tmp/test")._tag).toBe("valid")
  })

  // 验证: 设备端 /data/local/tmp/ 路径在 allowlist 内通过校验 (调试常用路径)
  it("/data/local/tmp/ path in allowlist passes", () => {
    expect(validateDevicePath("/data/local/tmp/test")._tag).toBe("valid")
  })

  // 验证: 设备端 /sdcard/ 路径在 allowlist 内通过校验
  it("/sdcard/ path in allowlist passes", () => {
    expect(validateDevicePath("/sdcard/test")._tag).toBe("valid")
  })

  // 验证: 设备端 /system/ 路径越出 allowlist 被拒绝 (保护系统分区)
  it("/system/ path outside allowlist rejected", () => {
    const result = validateDevicePath("/system/bin/test")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("device_path_denied")
    }
  })

  // 验证: 设备端 /etc/ 路径越出 allowlist 被拒绝
  it("/etc/ path outside allowlist rejected", () => {
    expect(validateDevicePath("/etc/passwd")._tag).toBe("invalid")
  })

  // 验证: FR-OBJECT-002 路径等价 — `..` 规范化后越出 allowlist 被拒绝
  it("path equivalence: /data/../system/bin/x normalizes outside allowlist", () => {
    const result = validateDevicePath("/data/../system/bin/x")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("device_path_denied")
    }
  })

  // 验证: `..` 规范化后仍在 allowlist 内的路径放行
  it("path equivalence: /data/local/tmp/../saved stays inside allowlist", () => {
    expect(validateDevicePath("/data/local/tmp/../saved")._tag).toBe("valid")
  })

  // 验证: 相对路径 / 无法规范化的 `..` 路径失败关闭
  it("relative device path fails closed", () => {
    const result = validateDevicePath("data/local/tmp/x")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("device_path_denied")
    }
  })
})

describe("SEC2-002: Endpoint validators (§3)", () => {
  // 验证: localhost:port 端点通过校验 (本地回环)
  it("localhost:port passes", () => {
    expect(validateEndpoint("localhost:8080")._tag).toBe("valid")
  })

  // 验证: 127.0.0.1:port 端点通过校验 (本地回环 IPv4)
  it("127.0.0.1:port passes", () => {
    expect(validateEndpoint("127.0.0.1:8080")._tag).toBe("valid")
  })

  // 验证: 外部 IP 端点被拒绝 (仅允许本地回环)
  it("external IP rejected", () => {
    const result = validateEndpoint("192.168.1.1:8080")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("endpoint_not_allowed")
    }
  })

  // 验证: 格式非法的端点被拒绝
  it("invalid endpoint rejected", () => {
    expect(validateEndpoint("not-an-endpoint")._tag).toBe("invalid")
  })
})

describe("SEC2-002: Port validators (§3)", () => {
  // 验证: 端口 1024 (非特权端口起点) 通过校验
  it("port 1024 passes", () => {
    expect(validatePort(1024)._tag).toBe("valid")
  })

  // 验证: 端口 65535 (最大端口号) 通过校验
  it("port 65535 passes", () => {
    expect(validatePort(65535)._tag).toBe("valid")
  })

  // 验证: 特权端口 80 被拒绝 (< 1024 需 root 权限, 沙箱不应访问)
  it("port 80 rejected (privileged)", () => {
    const result = validatePort(80)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("endpoint_not_allowed")
    }
  })

  // 验证: 端口 0 被拒绝 (非法端口号)
  it("port 0 rejected", () => {
    expect(validatePort(0)._tag).toBe("invalid")
  })
})

describe("SEC2-002: Bundle validators (§2)", () => {
  // System bundle uninstall is rejected by isHardDeny in Step 3 (product-policy).
  // Even if one reaches Step 4, it is not in the project bundle list, so
  // validateBundle rejects it too (bundle_not_allowed).
  // 验证: ohos.* 系统 bundle 不在项目 bundle 列表时被 validateBundle 拒绝
  it("system bundle ohos.* rejected by validateBundle (not a project bundle)", () => {
    const result = validateBundle("ohos.system", ctx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("bundle_not_allowed")
    }
  })

  // 验证: 项目内的普通应用 bundle 通过校验
  it("project bundle passes", () => {
    expect(validateBundle("com.example.app", ctx)._tag).toBe("valid")
  })

  // 验证: 非项目 bundle 被拒绝 (无法识别为当前工程应用, fail closed)
  it("non-project bundle rejected", () => {
    const result = validateBundle("com.attacker.app", ctx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("bundle_not_allowed")
    }
  })

  // 验证: 项目 bundle 列表为空时所有 bundle 均被拒绝 (无法确认项目身份, fail closed)
  it("empty project bundle list rejects everything (fail closed)", () => {
    const emptyCtx: ValidationContext = { ...ctx, projectBundles: [] }
    expect(validateBundle("com.example.app", emptyCtx)._tag).toBe("invalid")
  })

  // 验证: bundle 名称为空时被拒绝 (uninstall 必须指定 bundle)
  it("undefined bundle rejected", () => {
    const result = validateBundle(undefined, ctx)
    expect(result._tag).toBe("invalid")
  })
})

describe("SEC2-002: Target device validators (§4)", () => {
  // 验证: 非设备操作 (version/help) 携带 not_applicable 目标设备时通过校验
  it("non-device operation with not_applicable target passes", () => {
    const op: HdcOperation = { kind: "versionOrHelp" }
    expect(validateTargetDevice(op, noDevCtx)._tag).toBe("valid")
  })

  // 验证: 非设备操作 (version/help) 携带 explicit 目标设备时被拒绝 (语义冲突)
  it("non-device operation with explicit target rejected", () => {
    const op: HdcOperation = { kind: "versionOrHelp" }
    const result = validateTargetDevice(op, ctx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("invalid_request")
    }
  })

  // 验证: 设备操作 (install) 未指定目标设备时被拒绝 (target_device_ambiguous)
  it("device operation without target rejected", () => {
    const op: HdcOperation = { kind: "install", packagePath: "/app.hap" }
    const result = validateTargetDevice(op, noDevCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("target_device_ambiguous")
    }
  })

  // 验证: 设备操作 (install) 携带 raw 目标设备时被拒绝 (raw 设备未经 Permission 认证)
  it("device operation with raw target rejected", () => {
    const op: HdcOperation = { kind: "install", packagePath: "/app.hap" }
    const rawCtx: ValidationContext = { ...ctx, targetDevice: { selection: "raw", displayLabel: "unknown", permissionResource: "device:unknown" } }
    const result = validateTargetDevice(op, rawCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("target_device_ambiguous")
    }
  })
})

describe("SEC2-002: Operation-level validation (§5)", () => {
  const trustedCtx: HdcGuardTrustedContext = {
    sessionID: "ses_test",
    projectID: "proj_test",
    workspaceRoot: "/workspace",
    targetDevice: { selection: "explicit", displayLabel: "device-1", permissionResource: "device:123" },
    productPolicyVersion: "1.0",
    projectBundles: ["com.example.app"],
  }
  const request = { cwd: "/workspace/project" }

  // 验证: install 使用 workspace 内真实 hap (bundle 匹配项目) 通过完整 operation 校验
  it("install with workspace hap matching project bundle passes", () => {
    // 使用临时目录中的真实 zip hap 验证 install 校验 (路径 + 文件类型 + bundle 身份)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hdc-op-test-"))
    const tmpHap = path.join(tmpDir, "app.hap")
    fs.writeFileSync(tmpHap, makeFakeHap("com.example.app"))
    const tmpTrustedCtx = { ...trustedCtx, workspaceRoot: tmpDir, projectBundles: ["com.example.app"] }
    const tmpRequest = { cwd: tmpDir }
    try {
      const op: HdcOperation = { kind: "install", packagePath: tmpHap }
      expect(validateOperation(op, tmpRequest, tmpTrustedCtx)._tag).toBe("valid")
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // 验证: install 的 hap 内 bundle 与项目不匹配时被拒绝 (bundle_not_allowed, FR-OBJECT-002)
  it("install with hap bundle mismatching project rejected (bundle_not_allowed)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hdc-op-test-"))
    const tmpHap = path.join(tmpDir, "app.hap")
    fs.writeFileSync(tmpHap, makeFakeHap("com.attacker.app"))
    const tmpTrustedCtx = { ...trustedCtx, workspaceRoot: tmpDir, projectBundles: ["com.example.app"] }
    const tmpRequest = { cwd: tmpDir }
    try {
      const op: HdcOperation = { kind: "install", packagePath: tmpHap }
      const result = validateOperation(op, tmpRequest, tmpTrustedCtx)
      expect(result._tag).toBe("invalid")
      if (result._tag === "invalid") {
        expect(result.reasonCode).toBe("bundle_not_allowed")
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // 验证: install 的 hap 无法解析 bundle 时被拒绝 (fail closed)
  it("install with unparseable hap rejected (fail closed)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hdc-op-test-"))
    const tmpHap = path.join(tmpDir, "app.hap")
    fs.writeFileSync(tmpHap, "this is not a zip")
    const tmpTrustedCtx = { ...trustedCtx, workspaceRoot: tmpDir, projectBundles: ["com.example.app"] }
    const tmpRequest = { cwd: tmpDir }
    try {
      const op: HdcOperation = { kind: "install", packagePath: tmpHap }
      const result = validateOperation(op, tmpRequest, tmpTrustedCtx)
      expect(result._tag).toBe("invalid")
      if (result._tag === "invalid") {
        expect(result.reasonCode).toBe("bundle_not_allowed")
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // 验证: install 路径不存在时被拒绝 (文件类型校验, 防止 TOCTOU)
  it("install with non-existent workspace path rejected (file type check)", () => {
    const op: HdcOperation = { kind: "install", packagePath: "/workspace/app.hap" }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("local_path_denied")
    }
  })

  // 验证: install 路径指向目录时被拒绝 (必须是普通文件)
  it("install with directory path rejected (not a regular file)", () => {
    const op: HdcOperation = { kind: "install", packagePath: "/workspace" }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("local_path_denied")
    }
  })

  // 验证: install 路径越出 workspace 时被拒绝
  it("install with outside path rejected", () => {
    const op: HdcOperation = { kind: "install", packagePath: "/tmp/app.hap" }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("local_path_denied")
    }
  })

  // 验证: file send 本地路径越出 workspace 时被拒绝
  it("file send with outside local path rejected", () => {
    const op: HdcOperation = { kind: "fileSend", localPath: "/etc/passwd", remotePath: "/data/local/tmp/p" }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
  })

  // 验证: file send 设备端路径越出 allowlist 时被拒绝 (保护 /system 等系统分区)
  it("file send with outside device path rejected", () => {
    const op: HdcOperation = { kind: "fileSend", localPath: "/workspace/file", remotePath: "/system/bin/test" }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
  })

  // 验证: bugreport 输出路径越出 workspace 时被直接拒绝 (非 ask;
  // §1.2 "输出范围校验通过…其他 deny" — bugreport 是 Always allow 候选,
  // 未校验的越界输出可能被持久放行)
  it("bugreport with outside output path rejected (local_path_denied)", () => {
    const op: HdcOperation = { kind: "bugreport", localPath: "/tmp/leak.zip" }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("local_path_denied")
    }
  })

  // 验证: 裸 `hdc bugreport` (无输出路径) 通过校验 — 输出落在 executor cwd
  // 即 workspace 根, 界内
  it("bare bugreport without output path passes", () => {
    const op: HdcOperation = { kind: "bugreport", localPath: undefined }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("valid")
  })

  // 验证: bugreport 输出到 workspace 内真实目录通过校验
  it("bugreport with in-workspace output path passes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hdc-op-test-"))
    const tmpTrustedCtx = { ...trustedCtx, workspaceRoot: tmpDir, projectBundles: ["com.example.app"] }
    const tmpRequest = { cwd: tmpDir }
    try {
      const op: HdcOperation = { kind: "bugreport", localPath: path.join(tmpDir, "report.zip") }
      expect(validateOperation(op, tmpRequest, tmpTrustedCtx)._tag).toBe("valid")
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // 验证: uninstall 系统 bundle 在 Step 4 也会被拒 (不在项目 bundle 列表; Step 3 isHardDeny 已先拒绝)
  it("uninstall with system bundle rejected by validateOperation (not a project bundle)", () => {
    const op: HdcOperation = { kind: "uninstall", bundleName: "com.ohos.settings" }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("bundle_not_allowed")
    }
  })

  // 验证: uninstall 项目内 bundle 通过校验
  it("uninstall with project bundle passes", () => {
    const op: HdcOperation = { kind: "uninstall", bundleName: "com.example.app" }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("valid")
  })

  // 验证: tconn 使用本地回环端点通过校验
  it("tconn with valid endpoint passes", () => {
    const op: HdcOperation = { kind: "transportConnect", endpoint: "127.0.0.1:8080" }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("valid")
  })

  // 验证: tconn 使用外部 IP 端点被拒绝
  it("tconn with invalid endpoint rejected", () => {
    const op: HdcOperation = { kind: "transportConnect", endpoint: "10.0.0.1:8080" }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
  })

  // 验证: shell rm 操作设备端 /data/ 路径通过校验
  it("shell rm with valid device path passes", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["rm", "/data/local/tmp/file"], interactive: false }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("valid")
  })

  // 验证: shell rm 操作设备端 /system/ 路径被拒绝 (保护系统分区)
  it("shell rm with invalid device path rejected", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["rm", "/system/bin/test"], interactive: false }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
  })

  // L2 回归: chmod 的 mode 参数 (如 644) 不再被当作设备路径参与越界校验
  it("shell chmod mode arg not treated as path (allowlisted path passes)", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["chmod", "644", "/data/local/tmp/file"], interactive: false }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("valid")
  })

  // 验证: chmod 带 -R 旗标时 mode 与路径仍正确区分
  it("shell chmod with -R flag still separates mode from path", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["chmod", "-R", "644", "/data/local/tmp/dir"], interactive: false }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("valid")
  })

  // 验证: chmod 作用系统分区仍被拒绝 (mode 修复不放松系统路径保护)
  it("shell chmod with system path still rejected", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["chmod", "644", "/system/file"], interactive: false }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("device_path_denied")
    }
  })

  // 验证: chown 的 owner 规格参数同样不参与路径校验
  it("shell chown owner spec not treated as path", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["chown", "shell:shell", "/data/local/tmp/file"], interactive: false }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("valid")
  })

  // 验证: chmod 多路径全部校验, 任一越界即拒绝
  it("shell chmod with multiple paths validates all", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["chmod", "644", "/data/local/tmp/a", "/system/b"], interactive: false }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("invalid")
  })

  // F.5: fport tcp:port:port 格式端口校验
  it("fport with tcp:8080:8080 passes (valid ports in tcp: format)", () => {
    const op: HdcOperation = { kind: "portForward", direction: "forward", args: ["tcp:8080:8080"] }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("valid")
  })

  it("fport with tcp:22:22 rejected (privileged port in tcp: format)", () => {
    const op: HdcOperation = { kind: "portForward", direction: "forward", args: ["tcp:22:22"] }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("endpoint_not_allowed")
    }
  })

  it("rport with tcp:65535:65535 passes", () => {
    const op: HdcOperation = { kind: "portForward", direction: "reverse", args: ["tcp:65535:65535"] }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("valid")
  })

  it("fport with tcp:1023:8080 rejected (one privileged port)", () => {
    const op: HdcOperation = { kind: "portForward", direction: "forward", args: ["tcp:1023:8080"] }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
  })
})

// ─── SEC2-002 §3: Param validators (F.1) ──────────────────
// param set <name> <value>: 只读前缀直接 deny, allowlist 内 ask, 其他 deny (fail closed)
// param get 不走此校验 (读取允许)
describe("SEC2-002: Param validators (§3, F.1)", () => {
  const trustedCtx: HdcGuardTrustedContext = {
    sessionID: "ses_test",
    projectID: "proj_test",
    workspaceRoot: "/workspace",
    targetDevice: { selection: "explicit", displayLabel: "device-1", permissionResource: "device:123" },
    productPolicyVersion: "1.0",
    projectBundles: ["com.example.app"],
  }
  const request = { cwd: "/workspace/project" }

  // 验证: 只读前缀 const.* 的 param set 直接 deny (不 ask)
  it("readonly prefix const.* denied (param_readonly)", () => {
    const result = validateParamName("const.product.model")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("param_readonly")
    }
  })

  // 验证: 只读前缀 ro.* 的 param set 直接 deny
  it("readonly prefix ro.* denied (param_readonly)", () => {
    const result = validateParamName("ro.product.brand")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("param_readonly")
    }
  })

  // 验证: 只读前缀 ohos.boot.* 的 param set 直接 deny
  it("readonly prefix ohos.boot.* denied (param_readonly)", () => {
    const result = validateParamName("ohos.boot.serialno")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("param_readonly")
    }
  })

  // 验证: allowlist 内的 debug.* 参数通过校验 (后续走 ask)
  it("allowlist debug.* passes", () => {
    expect(validateParamName("debug.hilog.tags")._tag).toBe("valid")
  })

  // 验证: allowlist 内的 persist.sys.hilog.* 参数通过校验
  it("allowlist persist.sys.hilog.* passes", () => {
    expect(validateParamName("persist.sys.hilog.level")._tag).toBe("valid")
  })

  // 验证: allowlist 内的 hilog.* 参数通过校验
  it("allowlist hilog.* passes", () => {
    expect(validateParamName("hilog.flowctrl.proc.on")._tag).toBe("valid")
  })

  // 验证: allowlist 内的 web.debug.* 参数通过校验
  it("allowlist web.debug.* passes", () => {
    expect(validateParamName("web.debug.devtools")._tag).toBe("valid")
  })

  // 验证: allowlist 内的 persist.hdc.jdwp 参数通过校验
  it("allowlist persist.hdc.jdwp passes", () => {
    expect(validateParamName("persist.hdc.jdwp")._tag).toBe("valid")
  })

  // 验证: allowlist 内的 persist.graphic.profiler.* 参数通过校验
  it("allowlist persist.graphic.profiler.* passes", () => {
    expect(validateParamName("persist.graphic.profiler.enabled")._tag).toBe("valid")
  })

  // 验证: 已移除的 persist.ace.darkmode 不再在 allowlist 中 (fail closed)
  it("removed persist.ace.darkmode denied (param_not_allowed)", () => {
    const result = validateParamName("persist.ace.darkmode")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("param_not_allowed")
    }
  })

  // 验证: 已移除的 persist.sys.font_scale 不再在 allowlist 中 (fail closed)
  it("removed persist.sys.font_scale denied (param_not_allowed)", () => {
    const result = validateParamName("persist.sys.font_scale")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("param_not_allowed")
    }
  })

  // 验证: 不在 allowlist 内的 persist.* 参数被拒绝 (fail closed)
  it("non-allowlist persist.* denied (param_not_allowed)", () => {
    const result = validateParamName("persist.sys.usb.config")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("param_not_allowed")
    }
  })

  // 验证: 不在 allowlist 内的 sys.* 参数被拒绝 (临时参数不在 allowlist)
  it("non-allowlist sys.* denied (param_not_allowed)", () => {
    const result = validateParamName("sys.usb.config")
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("param_not_allowed")
    }
  })

  // 验证: shell param set <只读前缀> 通过 operation 校验被拒绝 (param_readonly)
  it("shell param set with readonly prefix rejected via validateOperation", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["param", "set", "ro.product.model", "value"], interactive: false }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("param_readonly")
    }
  })

  // 验证: shell param set <allowlist> 通过 operation 校验
  it("shell param set with allowlisted param passes via validateOperation", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["param", "set", "debug.hilog.tags", "D"], interactive: false }
    expect(validateOperation(op, request, trustedCtx)._tag).toBe("valid")
  })

  // 验证: shell param set <非 allowlist> 通过 operation 校验被拒绝
  it("shell param set with non-allowlisted param rejected via validateOperation", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["param", "set", "persist.sys.usb.config", "adb"], interactive: false }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("invalid")
    if (result._tag === "invalid") {
      expect(result.reasonCode).toBe("param_not_allowed")
    }
  })

  // 验证: shell param get 不走 param set 校验 (读取允许, 不被 param 校验拒绝)
  it("shell param get not subject to param set validation (read allowed)", () => {
    const op: HdcOperation = { kind: "shell", deviceArgv: ["param", "get", "ro.product.model"], interactive: false }
    const result = validateOperation(op, request, trustedCtx)
    expect(result._tag).toBe("valid")
  })
})
