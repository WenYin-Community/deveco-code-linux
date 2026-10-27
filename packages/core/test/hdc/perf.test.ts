import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HdcGuardLayer, HdcGuardService } from "../../src/hdc/guard"
import { HdcPermissionPort, type PermissionResult } from "../../src/hdc/permission-port"
import type { HdcGuardRequest, HdcGuardTrustedContext } from "../../src/hdc/decision"

// ─── SEC2 策略层性能基准测试（AR-SEC2-008 NFR §6）──────────
// 测量 HdcGuardService.decide() 策略层延迟，用于联合验收 #23 性能测试基线。
// 使用 FakePermissionPort 模拟 Permission（不含 SEC1 IPC 开销），数据用于
// 联合验收时对比端到端延迟。
//
// P95/P99 计算方式：对 N 次调用的耗时排序，取第 95/99 百分位值。
// 联合验收时：端到端延迟 ≈ SEC2 策略层延迟 + SEC1 coordinator/IPC 开销。

const V = "5.0.0"

const trustedCtx: HdcGuardTrustedContext = {
  sessionID: "ses_perf_001",
  projectID: "proj_perf",
  workspaceRoot: "/workspace",
  targetDevice: { selection: "explicit", displayLabel: "device-1", permissionResource: "device:123" },
  productPolicyVersion: "1.0.0",
  projectBundles: ["com.example.app"],
}

function makeRequest(argv: string[]): HdcGuardRequest {
  return { requestId: "req_perf", argv, cwd: "/workspace/project", hdcVersion: V }
}

// fake Permission layer: always allow（最快路径，测策略层下限延迟）
const fakeAllowLayer = Layer.succeed(HdcPermissionPort, {
  evaluate: () =>
    Effect.succeed({
      effect: "allow" as const,
      policySource: "permission_config" as const,
      approvalResult: "not_required" as const,
      needsApproval: false,
    }),
  awaitApproval: () =>
    Effect.succeed({
      effect: "allow" as const,
      policySource: "permission_config" as const,
      approvalResult: "not_required" as const,
      needsApproval: false,
    }),
})

// fake Permission layer: always deny（测硬拒绝/对象校验路径延迟）
const fakeDenyLayer = Layer.succeed(HdcPermissionPort, {
  evaluate: () =>
    Effect.succeed({
      effect: "deny" as const,
      policySource: "product_default" as const,
      approvalResult: "not_required" as const,
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

// ─── 百分位计算 ────────────────────────────────────────────
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

function stats(samples: number[]): { p50: number; p95: number; p99: number; avg: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    avg: samples.reduce((s, v) => s + v, 0) / samples.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

// ─── 典型 HDC 命令基准用例 ─────────────────────────────────
// 覆盖策略矩阵中所有路径：解析 → 硬拒绝 → 对象校验 → 已知策略 → 兜底 → Permission

const benchmarkCommands: { name: string; argv: string[]; layer: Layer.Layer<HdcPermissionPort>; expected: "allow" | "deny" }[] = [
  // 硬拒绝路径（不经过 Permission）
  { name: "hard-deny: mount", argv: ["mount", "/system"], layer: fakeAllowLayer, expected: "deny" },
  { name: "hard-deny: flash", argv: ["flash", "/system"], layer: fakeAllowLayer, expected: "deny" },

  // 版本/帮助（非设备操作，最快路径）
  { name: "non-device: version", argv: ["--version"], layer: fakeAllowLayer, expected: "allow" },
  { name: "non-device: help", argv: ["help"], layer: fakeAllowLayer, expected: "allow" },

  // 已知操作 + Permission allow 路径
  { name: "known: shell getprop", argv: ["shell", "getprop", "ro.build.version"], layer: fakeAllowLayer, expected: "allow" },
  { name: "known: file send", argv: ["file", "send", "local.txt", "/data/local/tmp/remote.txt"], layer: fakeAllowLayer, expected: "allow" },
  { name: "known: install", argv: ["install", "app.hap"], layer: fakeAllowLayer, expected: "allow" },
  { name: "known: hilog", argv: ["hilog"], layer: fakeAllowLayer, expected: "allow" },

  // 已知操作 + Permission deny 路径
  { name: "known-deny: shell", argv: ["shell", "getprop"], layer: fakeDenyLayer, expected: "deny" },
  { name: "known-deny: file send", argv: ["file", "send", "local.txt", "/data/local/tmp/remote.txt"], layer: fakeDenyLayer, expected: "deny" },

  // 兜底路径（unclassified → Permission）
  { name: "fallback: unknown-cmd", argv: ["custom-cmd", "--flag", "value"], layer: fakeAllowLayer, expected: "allow" },
  { name: "fallback-deny: unknown-cmd", argv: ["custom-cmd", "--flag", "value"], layer: fakeDenyLayer, expected: "deny" },

  // invalid_request 路径（CON-04 fail closed，不经过 Permission）
  { name: "invalid: file-no-args", argv: ["file"], layer: fakeAllowLayer, expected: "deny" },
  { name: "invalid: install-no-path", argv: ["install", "-r"], layer: fakeAllowLayer, expected: "deny" },

  // capability_unsupported 路径（不经过 Permission）
  { name: "capability: bare-shell", argv: ["shell"], layer: fakeAllowLayer, expected: "deny" },
]

const N = 1000 // 每个用例调用次数

describe("SEC2-008: 策略层性能基准（联合验收 #23 基线）", () => {
  // 输出基线数据表，联合验收时与端到端数据对比
  it("策略层延迟基线（P50/P95/P99，单位 μs）", async () => {
    const results: { name: string; p50: number; p95: number; p99: number; avg: number }[] = []

    for (const cmd of benchmarkCommands) {
      const layer = Layer.provide(HdcGuardLayer, cmd.layer)
      const program = Effect.gen(function* () {
        const guard = yield* HdcGuardService
        const samples: number[] = []

        // warmup（10 次，不记录）
        for (let w = 0; w < 10; w++) {
          yield* guard.decide(makeRequest(cmd.argv), trustedCtx)
        }

        // 测量
        for (let i = 0; i < N; i++) {
          const start = performance.now()
          yield* guard.decide(makeRequest(cmd.argv), trustedCtx)
          const end = performance.now()
          samples.push((end - start) * 1000) // → μs
        }

        const s = stats(samples)
        return { name: cmd.name, p50: s.p50, p95: s.p95, p99: s.p99, avg: s.avg }
      })

      const result = await Effect.runPromise(Effect.provide(program, layer))
      results.push(result)
    }

    // 输出基线数据表
    console.log("\n┌────────────────────────────────────────────────────────────────────────┐")
    console.log("│  SEC2 策略层延迟基线（FakePermissionPort，N=1000，单位 μs）             │")
    console.log("├──────────────────────────────┬────────┬────────┬────────┬────────┤")
    console.log("│ Command                      │   P50  │   P95  │   P99  │   Avg  │")
    console.log("├──────────────────────────────┼────────┼────────┼────────┼────────┤")
    for (const r of results) {
      console.log(
        `│ ${r.name.padEnd(28)} │ ${r.p50.toFixed(1).padStart(6)} │ ${r.p95.toFixed(1).padStart(6)} │ ${r.p99.toFixed(1).padStart(6)} │ ${r.avg.toFixed(1).padStart(6)} │`,
      )
    }
    console.log("└──────────────────────────────┴────────┴────────┴────────┴────────┘")
    console.log("  联合验收对比：端到端延迟 ≈ SEC2 基线 + SEC1 coordinator/IPC 开销\n")

    // 性能断言：策略层 P99 应 < 5ms（NFR §6 延迟要求）
    for (const r of results) {
      expect(r.p99).toBeLessThan(5000) // 5ms = 5000μs
    }
  })

  it("批量并发 decide 性能（100 并发，测无竞态）", async () => {
    const layer = Layer.provide(HdcGuardLayer, fakeAllowLayer)
    const program = Effect.gen(function* () {
      const guard = yield* HdcGuardService
      const argv = ["shell", "getprop", "ro.build.version"]

      const start = performance.now()
      const tasks: ReturnType<typeof guard.decide>[] = []
      for (let i = 0; i < 100; i++) {
        tasks.push(guard.decide(makeRequest(argv), trustedCtx))
      }
      const results = yield* Effect.all(tasks)
      const elapsed = (performance.now() - start) * 1000 // → μs

      // 100 并发全部 allow
      const allAllow = results.every((d) => d.kind === "allow")
      return { count: results.length, allAllow, elapsed }
    })

    const result = await Effect.runPromise(Effect.provide(program, layer))
    expect(result.count).toBe(100)
    expect(result.allAllow).toBe(true)
    console.log(`100 并发 decide 总耗时: ${result.elapsed.toFixed(0)}μs`)
  })
})
