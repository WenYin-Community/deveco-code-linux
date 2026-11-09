import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { HdcGuardLayer, HdcGuardService } from "../../src/hdc/guard"
import { HdcPermissionPort } from "../../src/hdc/permission-port"
import type { PermissionResult } from "../../src/hdc/permission-port"
import { FakePermissionPortLayer } from "../../src/hdc/permission-adapter"
import { createDecisionId } from "../../src/hdc/decision"
import type { HdcGuardRequest, HdcGuardTrustedContext } from "../../src/hdc/decision"

// ─── SEC2-008: HdcGuardService 与最终决策契约 ──────────────
// ─── SEC2-003: 硬拒绝不可覆盖 ────────────────────────────
// ─── SEC2-005: 非策略失败不进入兜底 ──────────────────────

const V = "5.0.0"

const trustedCtx: HdcGuardTrustedContext = {
  sessionID: "ses_test_001",
  projectID: "proj_test",
  workspaceRoot: "/workspace",
  targetDevice: { selection: "explicit", displayLabel: "device-1", permissionResource: "device:123" },
  productPolicyVersion: "1.0",
  projectBundles: ["com.example.app"],
}

const noDevCtx: HdcGuardTrustedContext = {
  sessionID: "ses_test_001",
  projectID: "proj_test",
  workspaceRoot: "/workspace",
  targetDevice: { selection: "not_applicable" },
  productPolicyVersion: "1.0",
  projectBundles: ["com.example.app"],
}

function makeRequest(argv: string[], overrides: Partial<HdcGuardRequest> = {}): HdcGuardRequest {
  return { requestId: "req_test_001", argv, cwd: "/workspace/project", hdcVersion: V, ...overrides }
}

// 构造符合 PermissionResult schema 的 fake evaluate 返回值, 避免使用 any
function makeFakeEvaluateResult(effect: "allow" | "deny" | "ask", policySource: PermissionResult["policySource"], approvalResult: PermissionResult["approvalResult"], needsApproval: boolean): PermissionResult {
  return { effect, policySource, approvalResult, needsApproval }
}

// 构造符合 PermissionResult schema 的 fake awaitApproval 返回值
function makeFakeApprovalResult(effect: "allow" | "deny", policySource: PermissionResult["policySource"], approvalResult: PermissionResult["approvalResult"], needsApproval: boolean, timedOut?: boolean): PermissionResult {
  return timedOut === undefined
    ? { effect, policySource, approvalResult, needsApproval }
    : { effect, policySource, approvalResult, needsApproval, timedOut }
}

// Custom fake layers for testing different Permission outcomes
function makeFakeLayer(evaluateResult: PermissionResult) {
  // evaluate=ask 时, awaitApproval 默认返回 timeout deny (用于 fail-closed 验证)
  // evaluate=allow/deny 时, awaitApproval 不会被调用, 返回值无所谓
  const approvalResult: PermissionResult = evaluateResult.effect === "ask"
    ? makeFakeApprovalResult("deny", "product_default", "denied", false, true)
    : evaluateResult

  return Layer.succeed(HdcPermissionPort, {
    evaluate: () => Effect.succeed(evaluateResult),
    awaitApproval: () => Effect.succeed(approvalResult),
  })
}

async function runGuard(request: HdcGuardRequest, ctx: HdcGuardTrustedContext, layer = FakePermissionPortLayer) {
  const testLayer = Layer.provide(HdcGuardLayer, layer)
  return Effect.gen(function* () {
    const guard = yield* HdcGuardService
    return yield* guard.decide(request, ctx)
  }).pipe(Effect.provide(testLayer), Effect.runPromise)
}

describe("SEC2-008: Fixed processing order (§1)", () => {
  // 验证: 版本校验先于硬拒绝 — 未知版本即使命令是 mount 也返回 runtime_incompatible, 不进入硬拒绝
  it("version check before hard deny — unknown version returns runtime_incompatible even for mount", async () => {
    const req = makeRequest(["mount"], { hdcVersion: "2.0.0" })
    const decision = await runGuard(req, trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("runtime_incompatible")
      expect(decision.isPolicyDeny).toBe(false)
    }
  })

  // 验证: 硬拒绝先于对象校验 — mount 在任何目标上下文下都被硬拒绝
  it("hard deny before object validation — mount is denied regardless of target", async () => {
    const decision = await runGuard(makeRequest(["mount"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("hard_denied")
      expect(decision.isPolicyDeny).toBe(true)
    }
  })

  // 验证: shell 包装的固件变更 (hdc shell mount) 同样硬拒绝, 不降级为 ask
  it("shell-wrapped firmware mutation (hdc shell mount) is hard deny", async () => {
    const decision = await runGuard(makeRequest(["shell", "mount", "-o", "remount,rw", "/"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("hard_denied")
      expect(decision.isPolicyDeny).toBe(true)
    }
  })

  // 验证: ohos.* 系统 bundle 卸载属于硬拒绝, 不可被策略覆盖
  it("system bundle uninstall is hard deny (SEC2-003 §1)", async () => {
    const decision = await runGuard(makeRequest(["uninstall", "ohos.settings"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("hard_denied")
      expect(decision.isPolicyDeny).toBe(true)
    }
  })

  // 验证: ohos.* 系统 bundle 卸载属于硬拒绝 (鸿蒙系统应用前缀)
  it("ohos system bundle uninstall is hard deny (SEC2-003 §1)", async () => {
    const decision = await runGuard(makeRequest(["uninstall", "ohos.system"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("hard_denied")
    }
  })

  // 验证: com.android.* / com.ohos.* 系统 bundle 卸载同样属于硬拒绝
  // (设备上的系统应用还沿用这两个命名空间, TC-05 要求覆盖)
  for (const bundleName of ["com.android.settings", "com.ohos.settings"]) {
    it(`${bundleName} uninstall is hard deny, not bundle_not_allowed (SEC2-003 §1)`, async () => {
      const direct = await runGuard(makeRequest(["uninstall", bundleName]), trustedCtx)
      expect(direct.kind).toBe("deny")
      if (direct.kind === "deny") {
        expect(direct.reasonCode).toBe("hard_denied")
      }

      const viaShell = await runGuard(makeRequest(["shell", "bm", "uninstall", "-n", bundleName]), trustedCtx)
      expect(viaShell.kind).toBe("deny")
      if (viaShell.kind === "deny") {
        expect(viaShell.reasonCode).toBe("hard_denied")
      }
    })
  }

  // 验证: 对象校验先于已知策略 — install 路径越界时返回 local_path_denied, 不进入 Permission
  it("object validation before known policy — install outside workspace rejected", async () => {
    const decision = await runGuard(makeRequest(["install", "/tmp/app.hap"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("local_path_denied")
    }
  })

  // 验证: bugreport 输出越界 workspace 时直接拒绝 (local_path_denied),
  // 不进入 ask — bugreport 是 Always allow 候选, 越界输出不可被审批持久化
  it("bugreport outside workspace rejected before ask", async () => {
    const allowLayer = makeFakeLayer({ effect: "allow", policySource: "saved_permission", approvalResult: "not_required", needsApproval: false })
    const decision = await runGuard(makeRequest(["bugreport", "/tmp/leak.zip"]), trustedCtx, allowLayer)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("local_path_denied")
    }
  })

  // 验证: 已知策略先于兜底 — version/help 命中已知 allow 策略, 不进入 unclassified 兜底
  it("known policy before fallback — version/help is allow with allow Permission", async () => {
    const allowLayer = makeFakeLayer({ effect: "allow", policySource: "saved_permission", approvalResult: "not_required", needsApproval: false })
    const decision = await runGuard(makeRequest(["version"]), noDevCtx, allowLayer)
    expect(decision.kind).toBe("allow")
  })

  // 验证: 未知命令进入 unclassified 兜底 ask 路径, 而非直接 deny (FakePermissionPort ask→timeout→deny)
  it("unknown command enters fallback ask, not direct deny", async () => {
    const decision = await runGuard(makeRequest(["unknown-cmd"]), trustedCtx)
    // FakePermissionPort returns ask → awaitApproval returns deny
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("approval_timeout")
    }
  })

  // 验证: 用户显式批准 (allow_once) 后, ask-ceiling 操作 (app_lifecycle) 可执行 —
  // ceiling 压缩的是未经审批的自动 allow, 不应把用户已批准的请求压回 deny
  // (aa start 已修正为 install_start/allow-ceiling, ask-ceiling 覆盖改用 force-stop)
  it("allow_once approval executes an ask-ceiling operation (aa force-stop)", async () => {
    const approveLayer = Layer.succeed(HdcPermissionPort, {
      evaluate: () =>
        Effect.succeed({
          effect: "ask" as const,
          policySource: "product_default" as const,
          approvalResult: "not_required" as const,
          needsApproval: true,
          permissionRequestId: "req-1",
        }),
      awaitApproval: () =>
        Effect.succeed({
          effect: "allow" as const,
          policySource: "one_time_approval" as const,
          approvalResult: "allow_once" as const,
          needsApproval: false,
        }),
    })
    const decision = await runGuard(makeRequest(["shell", "aa", "force-stop", "-b", "com.example.app"]), trustedCtx, approveLayer)
    expect(decision.kind).toBe("allow")
    if (decision.kind === "allow") {
      expect(decision.approvalResult).toBe("allow_once")
    }
  })

  // 验证: saved permission 只加速同一动作, 不得突破产品上限 (§1.10, TC-15) —
  // aa start 的 Always allow 保存后, 同一 bundle 的 aa force-stop 仍须弹窗。
  // evaluate 返回 saved_permission allow (当次无弹窗), ceiling=ask 必须
  // 走 awaitApproval 拿到当次审批后才允许执行。
  it("saved permission cannot bypass ask ceiling (aa force-stop) — prompts again", async () => {
    let approvalCalls = 0
    const savedLayer = Layer.succeed(HdcPermissionPort, {
      evaluate: () =>
        Effect.succeed({
          effect: "allow" as const,
          policySource: "saved_permission" as const,
          approvalResult: "always_allow" as const,
          needsApproval: false,
        }),
      awaitApproval: () =>
        Effect.sync(() => {
          approvalCalls++
          return {
            effect: "allow" as const,
            policySource: "one_time_approval" as const,
            approvalResult: "allow_once" as const,
            needsApproval: false,
            approvalPrompted: true,
          }
        }),
    })
    const decision = await runGuard(makeRequest(["shell", "aa", "force-stop", "com.example.app"]), trustedCtx, savedLayer)
    expect(approvalCalls).toBe(1)
    expect(decision.kind).toBe("allow")
    if (decision.kind === "allow") {
      expect(decision.approvalResult).toBe("allow_once")
      expect(decision.approvalPrompted).toBe(true)
    }
  })

  // 验证: saved permission 放行 + 无法取得当次审批 (端口仍返回无弹窗 allow)
  // → fail-closed deny(approval_denied), 不得执行 ask-ceiling 操作。
  it("saved permission without a prompt fails closed on ask-ceiling operation", async () => {
    const savedLayer = Layer.succeed(HdcPermissionPort, {
      evaluate: () =>
        Effect.succeed({
          effect: "allow" as const,
          policySource: "saved_permission" as const,
          approvalResult: "always_allow" as const,
          needsApproval: false,
        }),
      awaitApproval: () =>
        Effect.succeed({
          effect: "allow" as const,
          policySource: "saved_permission" as const,
          approvalResult: "always_allow" as const,
          needsApproval: false,
        }),
    })
    const decision = await runGuard(makeRequest(["shell", "aa", "force-stop", "com.example.app"]), trustedCtx, savedLayer)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("approval_denied")
    }
  })

  // 验证: aa force-stop 位置参数语法 (真实 hdc 语法, Windows 验证 L3) —
  // 工程 bundle 应进入 ask 可批准, 而非 bundle_not_allowed
  it("positional aa force-stop with project bundle reaches ask approval", async () => {
    const forceStopLayer = Layer.succeed(HdcPermissionPort, {
      evaluate: () =>
        Effect.succeed({
          effect: "ask" as const,
          policySource: "product_default" as const,
          approvalResult: "not_required" as const,
          needsApproval: true,
          permissionRequestId: "req-1",
        }),
      awaitApproval: () =>
        Effect.succeed({
          effect: "allow" as const,
          policySource: "one_time_approval" as const,
          approvalResult: "allow_once" as const,
          needsApproval: false,
        }),
    })
    const decision = await runGuard(makeRequest(["shell", "aa", "force-stop", "com.example.app"]), trustedCtx, forceStopLayer)
    expect(decision.kind).toBe("allow")
    if (decision.kind === "allow") {
      expect(decision.approvalResult).toBe("allow_once")
    }
  })

  // 验证: permRequest.canAlwaysAllow — aa start (install_start, ceiling=allow)
  // 为 true (TC-15: 审批弹窗须提供 Always allow); aa force-stop 保持 false。
  // 此前 aa start 误归 app_lifecycle 导致只有 Allow once。
  it("aa start passes canAlwaysAllow=true, force-stop false", async () => {
    const seen: boolean[] = []
    const captureLayer = Layer.succeed(HdcPermissionPort, {
      evaluate: (req: { canAlwaysAllow: boolean }) =>
        Effect.sync(() => {
          seen.push(req.canAlwaysAllow)
          return {
            effect: "deny" as const,
            policySource: "product_default" as const,
            approvalResult: "denied" as const,
            needsApproval: false,
          }
        }),
      awaitApproval: () =>
        Effect.succeed({
          effect: "deny" as const,
          policySource: "product_default" as const,
          approvalResult: "denied" as const,
          needsApproval: false,
        }),
    })
    await runGuard(makeRequest(["shell", "aa", "start", "-b", "com.example.app", "-a", "EntryAbility"]), trustedCtx, captureLayer)
    await runGuard(makeRequest(["shell", "aa", "force-stop", "com.example.app"]), trustedCtx, captureLayer)
    expect(seen).toEqual([true, false])
  })
})

describe("SEC2-003: Hard deny not overridable (§4)", () => {
  const allowLayer = makeFakeLayer({ effect: "allow", policySource: "saved_permission", approvalResult: "not_required", needsApproval: false })

  // 验证: 即使 Permission 返回 allow, mount 硬拒绝仍生效 (产品上限不可突破)
  it("mount + allow config → still denied", async () => {
    const decision = await runGuard(makeRequest(["mount"]), trustedCtx, allowLayer)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("hard_denied")
    }
  })

  // 验证: flash 硬拒绝不可被 allow 配置覆盖
  it("flash + allow config → still denied", async () => {
    const decision = await runGuard(makeRequest(["flash"]), trustedCtx, allowLayer)
    expect(decision.kind).toBe("deny")
  })

  // 验证: dd 硬拒绝不可被 allow 配置覆盖
  it("dd + allow config → still denied", async () => {
    const decision = await runGuard(makeRequest(["dd"]), trustedCtx, allowLayer)
    expect(decision.kind).toBe("deny")
  })

  // 验证: 硬拒绝不展示审批 — policySource=product_default, approvalResult=not_required
  it("hard deny does not show approval (policySource=product_default)", async () => {
    const decision = await runGuard(makeRequest(["mkfs"]), trustedCtx, allowLayer)
    if (decision.kind === "deny") {
      expect(decision.policySource).toBe("product_default")
      expect(decision.approvalResult).toBe("not_required")
    }
  })
})

describe("SEC2-005: Non-policy failures does not enter fallback (§4)", () => {
  // 验证: 未知 HDC 版本进入 failClosed (runtime_incompatible), 不进入 unclassified 兜底 ask
  it("runtime_incompatible → failClosed, not ask", async () => {
    const req = makeRequest(["version"], { hdcVersion: "0.0.0" })
    const decision = await runGuard(req, noDevCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("runtime_incompatible")
      expect(decision.isPolicyDeny).toBe(false)
    }
  })

  // 验证: 裸交互式 shell 进入 capability_unsupported, 不进入兜底 ask
  it("capability_unsupported → failClosed, not ask", async () => {
    const decision = await runGuard(makeRequest(["shell"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("capability_unsupported")
      expect(decision.isPolicyDeny).toBe(false)
    }
  })

  // 验证: 交互式解释器 (`hdc shell sh`, 无 -c) 同样 capability_unsupported
  // fail closed, 不进入可批准的 ask (批准后设备进程挂起残留, TC-41)
  it("interactive interpreter → failClosed capability_unsupported, not ask", async () => {
    const decision = await runGuard(makeRequest(["shell", "sh"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("capability_unsupported")
      expect(decision.isPolicyDeny).toBe(false)
    }
  })

  // 验证: 复合 shell (H1 复现) 进入 invalid_request failClosed, 不进入兜底 ask
  // 曾落入 unclassified ask → 批准后设备真实重启 (macOS 验证 2026-10-29)
  it("compound shell → failClosed invalid_request, not ask", async () => {
    const decision = await runGuard(makeRequest(["shell", "echo pwn; reboot"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("invalid_request")
      expect(decision.isPolicyDeny).toBe(false)
    }
  })

  // 验证: 对象校验失败进入 objectDeny (isPolicyDeny=true), 不进入兜底 ask
  it("object failure → objectDeny, not ask", async () => {
    const decision = await runGuard(makeRequest(["install", "/tmp/app.hap"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.isPolicyDeny).toBe(true)
    }
  })

  // 验证: 硬拒绝进入 hardDeny, 不进入兜底 ask
  it("hard deny → hardDeny, not fallback ask", async () => {
    const decision = await runGuard(makeRequest(["erase"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBe("hard_denied")
    }
  })
})

describe("SEC2-008: Decision structure (§2)", () => {
  // 验证: allow decision 包含 operation, targetDevice, decisionId, policySource, approvalResult 完整字段
  it("allow returns operation + targetDevice", async () => {
    const allowLayer = makeFakeLayer({ effect: "allow", policySource: "product_default", approvalResult: "not_required", needsApproval: false })
    const decision = await runGuard(makeRequest(["version"]), noDevCtx, allowLayer)
    expect(decision.kind).toBe("allow")
    if (decision.kind === "allow") {
      expect(decision.operation).toBeDefined()
      expect(decision.targetDevice).toBeDefined()
      expect(decision.decisionId).toBeDefined()
      expect(decision.policySource).toBe("product_default")
      expect(decision.approvalResult).toBe("not_required")
    }
  })

  // 验证: deny decision 包含 reasonCode 和 isPolicyDeny 字段
  it("deny returns reasonCode + isPolicyDeny", async () => {
    const decision = await runGuard(makeRequest(["mount"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.reasonCode).toBeDefined()
      expect(typeof decision.isPolicyDeny).toBe("boolean")
    }
  })

  // 验证: version/help 非设备操作的 allow 不虚构 target device (selection=not_applicable)
  it("version/help allow does not fabricate target device (§3)", async () => {
    const decision = await runGuard(makeRequest(["version"]), noDevCtx)
    if (decision.kind === "allow") {
      expect(decision.targetDevice.selection).toBe("not_applicable")
    }
  })

  // 验证: decisionId 以 dec_ 前缀生成, 符合 ID 规范
  it("decisionId starts with dec_", () => {
    const id = createDecisionId()
    expect(id.startsWith("dec_")).toBe(true)
  })

  // 验证: decisionId 每次生成唯一, 不重复
  it("decisionId is unique", () => {
    const id1 = createDecisionId()
    const id2 = createDecisionId()
    expect(id1).not.toBe(id2)
  })
})

describe("SEC2-008: policySource and approvalResult (§6)", () => {
  // 验证: 非设备查询 (list targets) 的 policySource=product_default, approvalResult=not_required
  it("product_default for version/help", async () => {
    const allowLayer = makeFakeLayer({ effect: "allow", policySource: "product_default", approvalResult: "not_required", needsApproval: false })
    const decision = await runGuard(makeRequest(["list", "targets"]), noDevCtx, allowLayer)
    if (decision.kind === "allow") {
      expect(decision.policySource).toBe("product_default")
      expect(decision.approvalResult).toBe("not_required")
    }
  })

  // 验证: system_state (reboot) 硬拒绝的 policySource=product_default 且 isPolicyDeny=true
  it("product_default for system_state deny", async () => {
    const decision = await runGuard(makeRequest(["reboot"]), trustedCtx)
    if (decision.kind === "deny") {
      expect(decision.policySource).toBe("product_default")
      expect(decision.isPolicyDeny).toBe(true)
    }
  })

  // F.6: hdc shell reboot must be system_state deny, not unclassified ask
  it("shell reboot → system_state deny (not unclassified ask)", async () => {
    const decision = await runGuard(makeRequest(["shell", "reboot"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.policySource).toBe("product_default")
      expect(decision.isPolicyDeny).toBe(true)
    }
  })

  it("shell shutdown → system_state deny (not unclassified ask)", async () => {
    const decision = await runGuard(makeRequest(["shell", "shutdown"]), trustedCtx)
    expect(decision.kind).toBe("deny")
    if (decision.kind === "deny") {
      expect(decision.policySource).toBe("product_default")
      expect(decision.isPolicyDeny).toBe(true)
    }
  })

  // 验证: Permission 返回 allow 时 decision.policySource=saved_permission (saved permission 命中)
  it("saved_permission when Permission returns allow", async () => {
    const allowLayer = makeFakeLayer({ effect: "allow", policySource: "saved_permission", approvalResult: "not_required", needsApproval: false })
    const decision = await runGuard(makeRequest(["shell", "getprop", "ro.build.version"]), trustedCtx, allowLayer)
    if (decision.kind === "allow") {
      expect(decision.policySource).toBe("saved_permission")
    }
  })
})

describe("SEC2-008: Guard does not modify argv (§5)", () => {
  // 验证: Guard decision 完成后原始 argv 不被修改 (allow/deny 均保持 argv 不变)
  it("original argv is preserved after decision", async () => {
    const argv = ["shell", "getprop", "ro.build.version"]
    const req = makeRequest([...argv])
    await runGuard(req, trustedCtx)
    // request.argv should not be mutated
    expect(req.argv).toEqual(argv)
  })
})

describe("SEC2-008: approvalPrompted passthrough (audit semantics, macOS verification §2.3-2)", () => {
  // saved permission 放行的重复执行 (当次无交互审批) → allow 决策不带 approvalPrompted
  // 审计据此记 "allow" 而非 "ask-approved"
  it("saved-permission allow without prompt carries no approvalPrompted", async () => {
    const savedLayer = Layer.succeed(HdcPermissionPort, {
      evaluate: () =>
        Effect.succeed({
          effect: "allow" as const,
          policySource: "saved_permission" as const,
          approvalResult: "always_allow" as const,
          needsApproval: false,
        }),
      awaitApproval: () =>
        Effect.succeed({
          effect: "deny" as const,
          policySource: "product_default" as const,
          approvalResult: "denied" as const,
          needsApproval: false,
        }),
    })
    const decision = await runGuard(makeRequest(["shell", "getprop", "ro.build.version"]), trustedCtx, savedLayer)
    expect(decision.kind).toBe("allow")
    if (decision.kind === "allow") {
      expect(decision.approvalResult).toBe("always_allow")
      expect(decision.approvalPrompted).toBeUndefined()
    }
  })

  // 用户当次在弹窗中批准 → allow 决策携带 approvalPrompted=true, 审计记 "ask-approved"
  it("interactive approval allow carries approvalPrompted=true", async () => {
    const promptedLayer = Layer.succeed(HdcPermissionPort, {
      evaluate: () =>
        Effect.succeed({
          effect: "allow" as const,
          policySource: "saved_permission" as const,
          approvalResult: "always_allow" as const,
          needsApproval: false,
          approvalPrompted: true,
        }),
      awaitApproval: () =>
        Effect.succeed({
          effect: "deny" as const,
          policySource: "product_default" as const,
          approvalResult: "denied" as const,
          needsApproval: false,
        }),
    })
    const decision = await runGuard(makeRequest(["shell", "getprop", "ro.build.version"]), trustedCtx, promptedLayer)
    expect(decision.kind).toBe("allow")
    if (decision.kind === "allow") {
      expect(decision.approvalResult).toBe("always_allow")
      expect(decision.approvalPrompted).toBe(true)
    }
  })
})

describe("SEC2-002: Object validation before Permission (§5)", () => {
  // 验证: 对象校验失败时不调用 Permission evaluate (通过 tracking layer 计数调用次数)
  it("object failure does not call Permission evaluate", async () => {
    let evaluateCalled = false
    const trackingLayer = Layer.succeed(HdcPermissionPort, {
      evaluate: () => Effect.gen(function* () { evaluateCalled = true; return { effect: "allow" as const, policySource: "saved_permission" as const, approvalResult: "not_required" as const, needsApproval: false } }),
      awaitApproval: () => Effect.succeed({ effect: "deny" as const, policySource: "product_default" as const, approvalResult: "denied" as const, needsApproval: false }),
    })
    const decision = await runGuard(makeRequest(["install", "/tmp/app.hap"]), trustedCtx, trackingLayer)
    expect(decision.kind).toBe("deny")
    expect(evaluateCalled).toBe(false)
  })
})
