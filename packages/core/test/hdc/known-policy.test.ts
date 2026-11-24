import { describe, expect, it } from "bun:test"
import { evaluateKnownPolicy, evaluateFallbackPolicy } from "../../src/hdc/known-policy"
import type { HdcOperation } from "../../src/hdc/operation"

// ─── SEC2-004: 基础与高级操作策略 ────────────────────────
// ─── SEC2-005: 未分类兜底与非策略失败 ──────────────────

const mk = (op: Partial<HdcOperation> & { kind: string }): HdcOperation => op as HdcOperation

describe("SEC2-004: evaluateKnownPolicy output (§4)", () => {
  // 验证: install operation 的 risk 字段被正确填充 (包含 "安装" 中文描述)
  it("produces risk description for each operation", () => {
    const op = mk({ kind: "install", packagePath: "/app.hap" })
    const result = evaluateKnownPolicy(op)
    expect(result.risk).toBeTruthy()
    expect(result.risk).toContain("安装")
  })

  // 验证: approvalFacts 字段被完整填充 (operationType, targetAppOrPath, targetDevice, reason)
  it("produces approvalFacts for each operation", () => {
    const op = mk({ kind: "install", packagePath: "/app.hap" })
    const result = evaluateKnownPolicy(op)
    expect(result.approvalFacts.operationType).toBeTruthy()
    expect(result.approvalFacts.targetAppOrPath).toBe("/app.hap")
    expect(result.approvalFacts.targetDevice).toBeTruthy()
    expect(result.approvalFacts.reason).toBeTruthy()
  })

  // 验证: 已知策略评估不修改原始 argv (op 引用不被 mutate)
  it("does not modify original argv (§4)", () => {
    const argv = ["custom", "--flag"]
    const op = mk({ kind: "unclassified", originalArgv: [...argv] })
    const result = evaluateKnownPolicy(op)
    // Evaluate should not modify the operation
    expect(op).toEqual(mk({ kind: "unclassified", originalArgv: [...argv] }))
  })

  // 验证: 非设备查询 (versionOrHelp) 默认 allow, policySource=product_default, approvalResult=not_required
  it("non_device_query: effect=allow, policySource=product_default", () => {
    const op = mk({ kind: "versionOrHelp" })
    const result = evaluateKnownPolicy(op)
    expect(result.effect).toBe("allow")
    expect(result.policySource).toBe("product_default")
    expect(result.approvalResult).toBe("not_required")
  })

  // 验证: system_state 操作 (modeOrDaemon) 默认 deny, ceiling=deny (产品上限禁止)
  it("system_state: effect=deny, ceiling=deny", () => {
    const op = mk({ kind: "modeOrDaemon", action: "smode" })
    const result = evaluateKnownPolicy(op)
    expect(result.effect).toBe("deny")
    expect(result.productCeiling).toBe("deny")
  })

  // 验证: install 默认 allow, ceiling=allow
  it("install: effect=allow, ceiling=allow", () => {
    const op = mk({ kind: "install", packagePath: "/app.hap" })
    const result = evaluateKnownPolicy(op)
    expect(result.effect).toBe("allow")
    expect(result.productCeiling).toBe("allow")
  })

  // 验证: fileSend approvalFacts 显示路径方向 (local → remote)
  it("file send approvalFacts show path direction", () => {
    const op = mk({ kind: "fileSend", localPath: "/local", remotePath: "/remote" })
    const result = evaluateKnownPolicy(op)
    expect(result.approvalFacts.operationType).toBe("file send")
    expect(result.approvalFacts.targetAppOrPath).toContain("/local")
    expect(result.approvalFacts.targetAppOrPath).toContain("/remote")
  })

  // 验证: shell approvalFacts 显示设备端命令 (operationType 包含 shell + getprop)
  it("shell approvalFacts show device command", () => {
    const op = mk({ kind: "shell", deviceArgv: ["getprop", "ro.build"], interactive: false })
    const result = evaluateKnownPolicy(op)
    expect(result.approvalFacts.operationType).toContain("shell")
    expect(result.approvalFacts.operationType).toContain("getprop")
  })
})

describe("SEC2-005: evaluateFallbackPolicy (§1/§2/§3)", () => {
  // 验证: unclassified operation 进入兜底 ask 路径 (非直接 deny, 允许用户审批)
  it("unclassified produces ask (§1)", () => {
    const op = mk({ kind: "unclassified", originalArgv: ["unknown"] })
    const result = evaluateFallbackPolicy(op)
    expect(result.effect).toBe("ask")
  })

  // 验证: unclassified risk 描述包含 "影响未知" (审批者需明确风险未知)
  it("unclassified risk contains '影响未知' (§2)", () => {
    const op = mk({ kind: "unclassified", originalArgv: ["unknown"] })
    const result = evaluateFallbackPolicy(op)
    expect(result.risk).toContain("影响未知")
  })

  // 验证: unclassified reason 包含 "未命中" (明确未命中已知策略)
  it("unclassified reason contains '未命中' (§2)", () => {
    const op = mk({ kind: "unclassified", originalArgv: ["unknown"] })
    const result = evaluateFallbackPolicy(op)
    expect(result.approvalFacts.reason).toContain("未命中")
  })

  // 验证: unclassified ceiling=ask, 不允许持久化 always allow (防止未知操作被永久批准)
  it("unclassified ceiling=ask, cannot persistent allow (§3)", () => {
    const op = mk({ kind: "unclassified", originalArgv: ["unknown"] })
    const result = evaluateFallbackPolicy(op)
    expect(result.productCeiling).toBe("ask")
  })

  // 验证: 非 unclassified operation 走 fallback 时被重定向到 known policy (如 install 仍是 allow)
  it("non-unclassified operation redirected to known policy", () => {
    const op = mk({ kind: "install", packagePath: "/app.hap" })
    const result = evaluateFallbackPolicy(op)
    // Should fall back to evaluateKnownPolicy for known operations
    expect(result.effect).toBe("allow")
  })
})
