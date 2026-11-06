import { describe, expect, it } from "bun:test"
import {
  isHardDeny,
  isSystemBundle,
  getProductPolicy,
  enforceCeiling,
  canAlwaysAllow,
} from "../../src/hdc/product-policy"
import type { HdcOperation } from "../../src/hdc/operation"
import type { PermissionEffect } from "../../src/hdc/decision"

// ─── SEC2-003: 产品硬拒绝与策略上限 ──────────────────────
// ─── SEC2-004: 基础与高级操作策略 ────────────────────────

const mk = (op: Partial<HdcOperation> & { kind: string }): HdcOperation => op as HdcOperation

describe("SEC2-003: Hard deny (§1)", () => {
  const hardDenyKinds = ["mount", "dd", "mkfs", "sideload", "update", "flash", "erase", "format"]

  // 验证: 8 种固件变更命令 (mount/dd/mkfs/sideload/update/flash/erase/format) 全部属于硬拒绝
  for (const cmd of hardDenyKinds) {
    it(`${cmd} isHardDeny=true`, () => {
      const op = mk({ kind: "firmwareMutation", command: cmd })
      expect(isHardDeny(op)).toBe(true)
    })
  }

  // 验证: 非固件操作 (versionOrHelp/install/shell) 不属于硬拒绝
  it("non-firmware operations are not hard deny", () => {
    expect(isHardDeny(mk({ kind: "versionOrHelp" }))).toBe(false)
    expect(isHardDeny(mk({ kind: "install", packagePath: "/app.hap" }))).toBe(false)
    expect(isHardDeny(mk({ kind: "shell", deviceArgv: ["ls"], interactive: false }))).toBe(false)
  })

  // 验证: com.android.* 和 ohos.* 系统 bundle 卸载属于硬拒绝 (保护系统应用)
  it("system bundle uninstall is hard deny (SEC2-003 §1)", () => {
    expect(isHardDeny(mk({ kind: "uninstall", bundleName: "com.android.settings" }))).toBe(true)
    expect(isHardDeny(mk({ kind: "uninstall", bundleName: "ohos.system" }))).toBe(true)
  })

  // 验证: 普通应用 bundle 卸载不属于硬拒绝 (可走用户审批)
  it("normal bundle uninstall is not hard deny", () => {
    expect(isHardDeny(mk({ kind: "uninstall", bundleName: "com.example.app" }))).toBe(false)
  })

  // 验证: isSystemBundle 前缀匹配 (com.android.* / ohos.* 为系统应用)
  it("isSystemBundle checks prefixes", () => {
    expect(isSystemBundle("com.android.settings")).toBe(true)
    expect(isSystemBundle("ohos.system")).toBe(true)
    expect(isSystemBundle("com.example.app")).toBe(false)
  })

  // 验证: 硬拒绝 operation 的 productDefault=deny, productCeiling=deny (全链路禁止)
  it("hard deny productDefault=deny, productCeiling=deny", () => {
    const op = mk({ kind: "firmwareMutation", command: "mount" })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("deny")
    expect(policy.productCeiling).toBe("deny")
  })

  // 验证: 硬拒绝 operation 的 canAlwaysAllow=false (不允许持久化 allow)
  it("hard deny canAlwaysAllow=false", () => {
    const op = mk({ kind: "firmwareMutation", command: "mount" })
    expect(canAlwaysAllow(op)).toBe(false)
  })
})

describe("SEC2-003: enforceCeiling (§3)", () => {
  // 验证: allow 被 deny 上限压制为 deny (产品上限不可突破)
  it("allow capped by deny ceiling → deny", () => {
    expect(enforceCeiling("allow" as PermissionEffect, "deny" as PermissionEffect)).toBe("deny")
  })

  // 验证: allow 被 ask 上限压制为 ask (上限比决策更严格)
  it("allow capped by ask ceiling → ask", () => {
    expect(enforceCeiling("allow" as PermissionEffect, "ask" as PermissionEffect)).toBe("ask")
  })

  // 验证: ask 被 deny 上限压制为 deny
  it("ask capped by deny ceiling → deny", () => {
    expect(enforceCeiling("ask" as PermissionEffect, "deny" as PermissionEffect)).toBe("deny")
  })

  // 验证: deny 不被 allow 上限放宽 (deny 不可被覆盖)
  it("deny not widened by allow ceiling", () => {
    expect(enforceCeiling("deny" as PermissionEffect, "allow" as PermissionEffect)).toBe("deny")
  })

  // 验证: allow 不被 allow 上限收紧 (两者相同保持 allow)
  it("allow not reduced by allow ceiling", () => {
    expect(enforceCeiling("allow" as PermissionEffect, "allow" as PermissionEffect)).toBe("allow")
  })

  // 验证: ask 不被 ask 上限收紧 (两者相同保持 ask)
  it("ask not reduced by ask ceiling", () => {
    expect(enforceCeiling("ask" as PermissionEffect, "ask" as PermissionEffect)).toBe("ask")
  })
})

describe("SEC2-004: Product policy matrix (§1/§2)", () => {
  // 验证: 非设备查询 (versionOrHelp) 默认 allow, 上限 allow (无需审批)
  it("non_device_query: default=allow, ceiling=allow", () => {
    const op = mk({ kind: "versionOrHelp" })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("allow")
    expect(policy.productCeiling).toBe("allow")
  })

  // 验证: 设备只读 (shell getprop) 默认 allow, 上限 allow (只读不审批)
  it("device_readonly: default=allow, ceiling=allow", () => {
    const op = mk({ kind: "shell", deviceArgv: ["getprop", "ro.build"], interactive: false })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("allow")
    expect(policy.productCeiling).toBe("allow")
  })

  // 验证: install 默认 ask, 上限 allow (需用户审批, 可持久化)
  it("install_start: default=ask, ceiling=allow", () => {
    const op = mk({ kind: "install", packagePath: "/app.hap" })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("ask")
    expect(policy.productCeiling).toBe("allow")
  })

  // 验证: 文件传输 (fileSend) 默认 ask, 上限 allow
  it("file_transfer: default=ask, ceiling=allow", () => {
    const op = mk({ kind: "fileSend", localPath: "/l", remotePath: "/r" })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("ask")
    expect(policy.productCeiling).toBe("allow")
  })

  // 验证: 应用生命周期 (uninstall) 默认 ask, 上限 ask (不允许持久化 allow)
  it("app_lifecycle: default=ask, ceiling=ask", () => {
    const op = mk({ kind: "uninstall", bundleName: "com.example.app" })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("ask")
    expect(policy.productCeiling).toBe("ask")
  })

  // 验证: 设备文件变更 (shell rm) 默认 ask, 上限 ask (每次需审批)
  it("device_file_change: default=ask, ceiling=ask", () => {
    const op = mk({ kind: "shell", deviceArgv: ["rm", "/data/file"], interactive: false })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("ask")
    expect(policy.productCeiling).toBe("ask")
  })

  // 验证: 参数变更 (param set) 默认 ask, 上限 ask
  it("param_change: default=ask, ceiling=ask", () => {
    const op = mk({ kind: "shell", deviceArgv: ["param", "set", "key", "val"], interactive: false })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("ask")
    expect(policy.productCeiling).toBe("ask")
  })

  // 验证: 诊断 (bugreport) 默认 ask, 上限 allow (可持久化)
  it("diagnostic: default=ask, ceiling=allow", () => {
    const op = mk({ kind: "bugreport", localPath: undefined })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("ask")
    expect(policy.productCeiling).toBe("allow")
  })

  // 验证: 连接转发 (transportConnect) 默认 ask, 上限 ask
  it("connection_forward: default=ask, ceiling=ask", () => {
    const op = mk({ kind: "transportConnect", endpoint: "127.0.0.1:8080" })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("ask")
    expect(policy.productCeiling).toBe("ask")
  })

  // 验证: 系统状态 (modeOrDaemon) 默认 deny, 上限 deny (完全禁止)
  it("system_state: default=deny, ceiling=deny", () => {
    const op = mk({ kind: "modeOrDaemon", action: "smode" })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("deny")
    expect(policy.productCeiling).toBe("deny")
  })

  // 验证: 未分类 (unclassified) 默认 ask, 上限 ask (兜底策略保守)
  it("unclassified: default=ask, ceiling=ask", () => {
    const op = mk({ kind: "unclassified", originalArgv: ["unknown"] })
    const policy = getProductPolicy(op)
    expect(policy.productDefault).toBe("ask")
    expect(policy.productCeiling).toBe("ask")
  })
})

describe("SEC2-004/007: canAlwaysAllow (§3)", () => {
  // 验证: install (ceiling=allow) 允许持久化 → canAlwaysAllow=true
  it("install (ceiling=allow) → true", () => {
    expect(canAlwaysAllow(mk({ kind: "install", packagePath: "/app.hap" }))).toBe(true)
  })

  // 验证: aa start (install_start, ceiling=allow) 提供 Always allow
  // (SR2 §2.3 / FR-APPROVAL-101; TC-15: 此前误归 app_lifecycle 导致缺失)
  it("aa start (ceiling=allow) → true", () => {
    expect(canAlwaysAllow(mk({ kind: "appControl", action: "aa start", bundleName: "com.example.app" }))).toBe(true)
  })

  // 验证: aa force-stop (app_lifecycle, ceiling=ask) 不提供 Always allow
  it("aa force-stop (ceiling=ask) → false", () => {
    expect(canAlwaysAllow(mk({ kind: "appControl", action: "aa force-stop", bundleName: "com.example.app" }))).toBe(false)
  })

  // 验证: uninstall (ceiling=ask) 不允许持久化 → canAlwaysAllow=false
  it("uninstall (ceiling=ask) → false", () => {
    expect(canAlwaysAllow(mk({ kind: "uninstall", bundleName: "com.example" }))).toBe(false)
  })

  // 验证: system_state (ceiling=deny) 不允许持久化 → canAlwaysAllow=false
  it("system_state (ceiling=deny) → false", () => {
    expect(canAlwaysAllow(mk({ kind: "modeOrDaemon", action: "smode" }))).toBe(false)
  })

  // 验证: firmwareMutation (硬拒绝) 不允许持久化 → canAlwaysAllow=false
  it("firmwareMutation → false", () => {
    expect(canAlwaysAllow(mk({ kind: "firmwareMutation", command: "mount" }))).toBe(false)
  })
})
