import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { HdcPermissionAdapterLayer } from "../../src/hdc/permission-adapter"
import { HdcPermissionPort } from "../../src/hdc/permission-port"
import type { PermissionRequest } from "../../src/hdc/permission-port"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

// ─── SEC2-006/007 偏差 #5-6: adapter 事件流订阅 + allow_once/always_allow 区分 ──

const database = Database.layerFromPath(":memory:")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
)
const saved = PermissionSaved.layer.pipe(Layer.provide(database))
const permissionLayer = PermissionV2.locationLayer.pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(store),
  Layer.provideMerge(events),
  Layer.provideMerge(current),
  Layer.provideMerge(sessions),
  Layer.provideMerge(SessionExecution.noopLayer),
  Layer.provideMerge(saved),
)
const adapterLayer = HdcPermissionAdapterLayer.pipe(Layer.provideMerge(permissionLayer))
const it = testEffect(adapterLayer)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const update = yield* agents.transform()
    yield* update((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function makeRequest(canAlwaysAllow = true): PermissionRequest {
  return {
    requestId: "req_test_001",
    sessionID: "ses_test",
    action: "hdc:shell",
    resource: "device:123/cmd:ls",
    productDefault: "ask",
    productCeiling: "allow",
    operationType: "shell",
    targetAppOrPath: "ls",
    targetDevice: "device-1",
    risk: "low",
    reason: "test",
    command: "hdc shell ls",
    canAlwaysAllow,
  }
}

// 监听 Asked 事件, 拿到 Permission 内部 requestID, 调用 reply
function waitForAskedAndReply(reply: "once" | "always" | "reject") {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const request = yield* Deferred.await(asked)
    yield* service.reply({ requestID: request.id, reply })
    return request
  })
}

describe("SEC2-006/007 偏差 #5-6: HdcPermissionAdapterLayer 事件流订阅", () => {
  // 验证: evaluate 阶段 rules deny → 返回 effect: deny, 不进入 awaitApproval 流程
  it.effect("evaluate rules deny → effect: deny, 不触发 awaitApproval", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "hdc:shell", resource: "*", effect: "deny" }])
      const port = yield* HdcPermissionPort
      const result = yield* port.evaluate(makeRequest())
      expect(result.effect).toBe("deny")
      expect(result.policySource).toBe("permission_config")
      expect(result.approvalResult).toBe("denied")
      expect(result.needsApproval).toBe(false)
    }),
  )

  // 验证: evaluate 阶段 saved permission 命中 → 返回 effect: allow, 不进入 awaitApproval
  it.effect("evaluate saved allow → effect: allow, 不触发 awaitApproval", () =>
    Effect.gen(function* () {
      yield* setup()
      const savedService = yield* PermissionSaved.Service
      yield* savedService.add({ projectID: Project.ID.global, action: "hdc:shell", resources: ["device:123/cmd:ls"] })
      const port = yield* HdcPermissionPort
      const result = yield* port.evaluate(makeRequest())
      expect(result.effect).toBe("allow")
      expect(result.policySource).toBe("saved_permission")
      expect(result.needsApproval).toBe(false)
    }),
  )

  // 验证: evaluate 阶段无规则命中 → 返回 effect: ask, 记录 Permission 内部 requestID 供 awaitApproval 使用
  it.effect("evaluate 无规则 → effect: ask, 记录 requestID", () =>
    Effect.gen(function* () {
      yield* setup()
      const port = yield* HdcPermissionPort
      const result = yield* port.evaluate(makeRequest())
      expect(result.effect).toBe("ask")
      expect(result.needsApproval).toBe(true)
    }),
  )

  // 验证: awaitApproval 收到 reply=once → 返回 allow_once (一次性允许, 不持久化)
  it.effect("awaitApproval reply=once → allow_once", () =>
    Effect.gen(function* () {
      yield* setup()
      const port = yield* HdcPermissionPort

      // 并发: evaluate → awaitApproval, 同时监听 Asked 事件触发 reply=once
      const fiber = yield* Effect.gen(function* () {
        const evalResult = yield* port.evaluate(makeRequest())
        if (evalResult.effect !== "ask") throw new Error(`expected ask, got ${evalResult.effect}`)
        return yield* port.awaitApproval(makeRequest(), evalResult)
      }).pipe(Effect.forkScoped)

      yield* waitForAskedAndReply("once")
      const result = yield* Fiber.join(fiber)

      expect(result.effect).toBe("allow")
      expect(result.policySource).toBe("one_time_approval")
      expect(result.approvalResult).toBe("allow_once")
      expect(result.needsApproval).toBe(false)
      expect(result.timedOut).toBeUndefined()
    }),
  )

  // 验证: awaitApproval 收到 reply=always → 返回 always_allow, policySource=saved_permission (持久化允许)
  it.effect("awaitApproval reply=always → always_allow, policySource=saved_permission", () =>
    Effect.gen(function* () {
      yield* setup()
      const port = yield* HdcPermissionPort

      const fiber = yield* Effect.gen(function* () {
        const evalResult = yield* port.evaluate(makeRequest())
        if (evalResult.effect !== "ask") throw new Error(`expected ask, got ${evalResult.effect}`)
        return yield* port.awaitApproval(makeRequest(), evalResult)
      }).pipe(Effect.forkScoped)

      yield* waitForAskedAndReply("always")
      const result = yield* Fiber.join(fiber)

      expect(result.effect).toBe("allow")
      expect(result.policySource).toBe("saved_permission")
      expect(result.approvalResult).toBe("always_allow")
      expect(result.needsApproval).toBe(false)
    }),
  )

  // 验证: awaitApproval 收到 reply=reject → 返回 deny (用户拒绝)
  it.effect("awaitApproval reply=reject → deny", () =>
    Effect.gen(function* () {
      yield* setup()
      const port = yield* HdcPermissionPort

      const fiber = yield* Effect.gen(function* () {
        const evalResult = yield* port.evaluate(makeRequest())
        if (evalResult.effect !== "ask") throw new Error(`expected ask, got ${evalResult.effect}`)
        return yield* port.awaitApproval(makeRequest(), evalResult)
      }).pipe(Effect.forkScoped)

      yield* waitForAskedAndReply("reject")
      const result = yield* Fiber.join(fiber)

      expect(result.effect).toBe("deny")
      expect(result.approvalResult).toBe("denied")
      expect(result.needsApproval).toBe(false)
    }),
  )

  // 验证: awaitApproval 在无前置 evaluate 时 → fail-closed timeout (异常调用顺序的保护)
  it.effect("awaitApproval 无前置 evaluate → fail-closed timeout", () =>
    Effect.gen(function* () {
      yield* setup()
      const port = yield* HdcPermissionPort
      // 直接调用 awaitApproval, 没有 evaluate 返回的 permissionRequestId
      const result = yield* port.awaitApproval(makeRequest(), {
        effect: "ask",
        policySource: "product_default",
        approvalResult: "not_required",
        needsApproval: true,
      })
      expect(result.effect).toBe("deny")
      expect(result.approvalResult).toBe("denied")
      expect(result.timedOut).toBe(true)
    }),
  )

  // 验证: reply=always 后再次 evaluate → effect: allow (saved permission 已持久化, 下次自动命中)
  it.effect("reply=always 后再次 evaluate → effect: allow (saved permission 生效)", () =>
    Effect.gen(function* () {
      yield* setup()
      const port = yield* HdcPermissionPort

      // 第一次: ask + reply=always, 触发 saved.add
      const fiber1 = yield* Effect.gen(function* () {
        const evalResult = yield* port.evaluate(makeRequest())
        if (evalResult.effect !== "ask") throw new Error(`expected ask, got ${evalResult.effect}`)
        return yield* port.awaitApproval(makeRequest(), evalResult)
      }).pipe(Effect.forkScoped)
      yield* waitForAskedAndReply("always")
      const result1 = yield* Fiber.join(fiber1)
      expect(result1.approvalResult).toBe("always_allow")

      // 第二次: 应该命中 saved permission, effect: allow
      const result2 = yield* port.evaluate(makeRequest())
      expect(result2.effect).toBe("allow")
      expect(result2.policySource).toBe("saved_permission")
    }),
  )

  // 验证: reply=once 后再次 evaluate → 仍是 ask (一次性允许不持久化)
  it.effect("reply=once 后再次 evaluate → 仍是 ask (未持久化)", () =>
    Effect.gen(function* () {
      yield* setup()
      const port = yield* HdcPermissionPort

      const fiber1 = yield* Effect.gen(function* () {
        const evalResult = yield* port.evaluate(makeRequest())
        if (evalResult.effect !== "ask") throw new Error(`expected ask, got ${evalResult.effect}`)
        return yield* port.awaitApproval(makeRequest(), evalResult)
      }).pipe(Effect.forkScoped)
      yield* waitForAskedAndReply("once")
      const result1 = yield* Fiber.join(fiber1)
      expect(result1.approvalResult).toBe("allow_once")

      // 第二次: 不应该命中 saved, 仍是 ask
      const result2 = yield* port.evaluate(makeRequest())
      expect(result2.effect).toBe("ask")
      expect(result2.needsApproval).toBe(true)
    }),
  )

  // 验证: canAlwaysAllow=false 时即使 reply=always 也不持久化 (Permission 内部 save 数组为空)
  // AR-SEC2-007 §3: 只有 productCeiling=allow 才显示 Always allow
  // canAlwaysAllow=false 时用户不应看到 Always allow, 若 Permission UI 异常返回 always,
  // adapter recheck ask() 发现 saved permission 未持久化 → fail-closed (saved_permission_failed)
  it.effect("canAlwaysAllow=false 时 reply=always → saved_permission_failed (AR-SEC2-007 §3/§4 合规)", () =>
    Effect.gen(function* () {
      yield* setup()
      const port = yield* HdcPermissionPort
      const req = makeRequest(false) // canAlwaysAllow=false

      const fiber = yield* Effect.gen(function* () {
        const evalResult = yield* port.evaluate(req)
        if (evalResult.effect !== "ask") throw new Error(`expected ask, got ${evalResult.effect}`)
        return yield* port.awaitApproval(req, evalResult)
      }).pipe(Effect.forkScoped)

      yield* waitForAskedAndReply("always")
      const result = yield* Fiber.join(fiber)

      // AR-SEC2-007 §3/§4: canAlwaysAllow=false 时不应 Always allow
      // recheck ask() 发现 saved permission 未持久化 → fail-closed
      expect(result.effect).toBe("deny")
      expect(result.approvalResult).toBe("denied")
      expect(result.savedPermissionFailed).toBe(true)
    }),
  )
})
