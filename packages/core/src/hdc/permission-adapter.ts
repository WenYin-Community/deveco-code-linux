import { Deferred, Effect, Layer } from "effect"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import type { PermissionRequest, PermissionResult } from "./permission-port"
import { HdcPermissionPort } from "./permission-port"

// ─── Permission adapter (AR-SEC2-006/007) ──────────────────
// Bridges HdcGuard's PermissionPort to the existing PermissionV2.Service.
//
// 实现策略（偏差 #5-6）:
// - adapter layer scope 启动时即用 events.listen 注册 Replied 事件 callback,
//   callback 在收到匹配 requestID 的事件时 succeed 对应的 Deferred
// - evaluate: 调用 permission.ask() 返回 effect; 若 effect === "ask",
//   预创建 Deferred 并放入 Map, 把 permissionRequestId 返还给调用方
//   * rules deny → effect: "deny"
//   * saved allow → effect: "allow"
//   * otherwise → effect: "ask", permissionRequestId 传给调用方
// - awaitApproval: 接收 evaluate 的返回值, 从中取 permissionRequestId,
//   从 Map 中拿到对应 Deferred, await 拿到 reply
//   * reply === "once"   → approvalResult: "allow_once"
//   * reply === "always" → 重新调用 ask() 验证 saved permission 是否已持久化:
//     - ask 返回 allow → approvalResult: "always_allow", policySource: "saved_permission"
//     - ask 仍返回 ask → saved.add 失败, fail-closed deny (saved_permission_failed)
//   * reply === "reject" → deny
//   * 超时/未收到事件 → fail-closed deny (timedOut: true)
//
// AR-SEC2-007 §4 合规: saved.add 失败时不乐观返回 always_allow, 而是重新
// 调用 ask() 验证 saved permission 是否已持久化. 若未持久化则 fail-closed,
// 不执行当前请求, 不静默降级为 Allow once.
//
// 不调用 permission.assert() 的原因:
// - assert() 返回 void 不携带 reply 字段, 无法区分 once/always
// - assert() 失败时抛 RejectedError/CorrectedError, 无法区分 saved.add 失败和用户拒绝
// - 事件流订阅能拿到 reply 字段, 直接区分 once/always/reject
//
// 时序说明:
// - listen 在 adapter layer 启动时即注册, 早于任何 ask() 调用
// - evaluate 阶段调用 ask() 前先创建 Deferred 并放入 Map,
//   即使 reply 在 awaitApproval 之前到达, callback 也能立即 succeed Deferred
// - awaitApproval 后续 await Deferred 拿到 reply, 不会丢失事件

export const HdcPermissionAdapterLayer = Layer.effect(
  HdcPermissionPort,
  Effect.gen(function* () {
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service

    // 内部状态: 双 Map 缓存机制
    // - repliedCache: requestID → reply (listener callback 收到事件时立即存入, 即使 evaluate 还没返回)
    // - repliedWaiters: requestID → Deferred (awaitApproval 阶段创建, 等待 reply)
    // 时序问题: permission.ask() 内部 publish Asked, 测试监听 Asked 后立即调 reply
    //   → publish Replied, 但此时 evaluate 的 ask() 还没返回, repliedWaiters 还没 set
    //   解决: callback 收到 reply 时, 先查 repliedWaiters (awaitApproval 已在等),
    //   没有则存入 repliedCache; awaitApproval 启动时先查 repliedCache, 有就直接返回
    // 注: listener callback 在 notify 的 Effect.forEach 中同步执行, 裸 Map 在 callback 内访问是安全的
    const repliedCache = new Map<string, { reply: PermissionV2.Reply; expires: number }>()
    const repliedWaiters = new Map<string, Deferred.Deferred<PermissionV2.Reply, never>>()

    // TTL cleanup: expired cache entries are removed on access
    const REPLIED_CACHE_TTL_MS = 60_000 // 60 seconds

    // 启动 listen, 生命周期跟随 adapter layer scope
    yield* events.listen((event) =>
      Effect.gen(function* () {
        if (event.type !== PermissionV2.Event.Replied.type) return
        const data = event.data as { requestID: PermissionV2.ID; reply: PermissionV2.Reply }
        // 先查 waiters (awaitApproval 已在等), succeed 它; 没有则存入 cache (带 TTL)
        const deferred = repliedWaiters.get(data.requestID)
        if (deferred) {
          repliedWaiters.delete(data.requestID)
          yield* Deferred.succeed(deferred, data.reply)
        } else {
          repliedCache.set(data.requestID, {
            reply: data.reply,
            expires: Date.now() + REPLIED_CACHE_TTL_MS,
          })
        }
      }),
    )

    const evaluate = (request: PermissionRequest): Effect.Effect<PermissionResult, Error> =>
      Effect.gen(function* () {
        const askResult = yield* permission.ask({
          sessionID: SessionV2.ID.descending(request.sessionID),
          action: request.action,
          resources: [request.resource],
          save: request.canAlwaysAllow ? [request.resource] : undefined,
          metadata: {
            operationType: request.operationType,
            targetAppOrPath: request.targetAppOrPath,
            targetDevice: request.targetDevice,
            risk: request.risk,
            reason: request.reason,
            command: request.command,
            productDefault: request.productDefault,
            productCeiling: request.productCeiling,
          },
        })

        if (askResult.effect === "allow") {
          return {
            effect: "allow" as const,
            policySource: "saved_permission" as const,
            approvalResult: "not_required" as const,
            needsApproval: false,
          }
        }

        if (askResult.effect === "deny") {
          return {
            effect: "deny" as const,
            policySource: "permission_config" as const,
            approvalResult: "denied" as const,
            needsApproval: false,
          }
        }

        // effect === "ask": 把 permissionRequestId 返还给调用方
        // 不在此处创建 Deferred; awaitApproval 阶段按需创建 (先查 cache, 再创建 waiter)
        return {
          effect: "ask" as const,
          policySource: "product_default" as const,
          approvalResult: "not_required" as const,
          needsApproval: true,
          permissionRequestId: askResult.id,
        }
      })

    // SEC2-007 §3/§4: awaitApproval 从 cache 或 listen 拿到 reply
    // - 调用方保证仅在 evaluate 返回 effect: "ask" 时调用
    // - 失败/超时: fail-closed deny (timedOut: true)
    const awaitApproval = (
      request: PermissionRequest,
      evaluateResult: PermissionResult,
    ): Effect.Effect<PermissionResult, Error> =>
      Effect.gen(function* () {
        const permissionRequestId = evaluateResult.permissionRequestId

        // 如果 evaluate 没返回 permissionRequestId (异常调用顺序), fail-closed
        if (!permissionRequestId) {
          return {
            effect: "deny" as const,
            policySource: "product_default" as const,
            approvalResult: "denied" as const,
            needsApproval: false,
            timedOut: true,
          }
        }

        // 先查 cache (reply 可能在 evaluate 返回前就到达)
        // permissionRequestId is string from Schema.optional, but actually PermissionV2.ID from askResult.id
        // Convert to PermissionV2.ID for waitForReply/repliedCache key consistency
        const requestId = PermissionV2.ID.create(permissionRequestId)
        const cached = repliedCache.get(requestId)
        // TTL check: remove if expired
        if (cached && Date.now() > cached.expires) {
          repliedCache.delete(requestId)
        }
        const reply = (cached && Date.now() <= cached.expires) ? cached.reply : (yield* waitForReply(requestId))

        // 清理 cache (如果是从 cache 拿的, 删除; 如果是 wait 拿的, 已经在 callback 中删除)
        repliedCache.delete(requestId)

        if (reply === "once") {
          return {
            effect: "allow" as const,
            policySource: "one_time_approval" as const,
            approvalResult: "allow_once" as const,
            needsApproval: false,
            approvalPrompted: true,
          }
        }

        if (reply === "always") {
          // AR-SEC2-007 §4 合规: saved.add 失败时不乐观返回 always_allow
          // 重新调用 ask() 验证 saved permission 是否已持久化
          // - ask 返回 allow → saved.add 成功, 返回 always_allow
          // - ask 仍返回 ask/deny → saved.add 失败, fail-closed (saved_permission_failed)
          const recheck = yield* permission.ask({
            sessionID: SessionV2.ID.descending(request.sessionID),
            action: request.action,
            resources: [request.resource],
            save: request.canAlwaysAllow ? [request.resource] : undefined,
            metadata: {
              operationType: request.operationType,
              targetAppOrPath: request.targetAppOrPath,
              targetDevice: request.targetDevice,
              risk: request.risk,
              reason: request.reason,
              productDefault: request.productDefault,
              productCeiling: request.productCeiling,
            },
          })

          if (recheck.effect === "allow") {
            // saved permission 已持久化, 返回 always_allow
            return {
              effect: "allow" as const,
              policySource: "saved_permission" as const,
              approvalResult: "always_allow" as const,
              needsApproval: false,
              approvalPrompted: true,
            }
          }

          // saved.add 失败, saved permission 未持久化
          // AR-SEC2-007 §4: 不得执行当前请求, 不降级为 Allow once
          return {
            effect: "deny" as const,
            policySource: "product_default" as const,
            approvalResult: "denied" as const,
            needsApproval: false,
            savedPermissionFailed: true,
          }
        }

        // reply === "reject"
        return {
          effect: "deny" as const,
          policySource: "product_default" as const,
          approvalResult: "denied" as const,
          needsApproval: false,
        }
      })

    // 等待 reply: 创建 Deferred 放入 waiters, 让 callback 在收到事件时 succeed 它
    // 超时保护: 30 秒未收到 reply → fail-closed deny (timedOut: true)
    function waitForReply(permissionRequestId: PermissionV2.ID): Effect.Effect<PermissionV2.Reply, never> {
      return Effect.gen(function* () {
        // 创建前再查一次 cache (避免在创建 Deferred 与 callback 之间错过事件)
        const cached = repliedCache.get(permissionRequestId)
        if (cached) {
          // TTL check: remove if expired
          if (Date.now() > cached.expires) {
            repliedCache.delete(permissionRequestId)
          } else {
            repliedCache.delete(permissionRequestId)
            return cached.reply
          }
        }
        const deferred = yield* Deferred.make<PermissionV2.Reply, never>()
        repliedWaiters.set(permissionRequestId, deferred)

        // 超时保护: 30 秒未收到 reply → 返回 reject reply (fail-closed)
        // Effect.timeout raises TimeoutError on timeout; catch it and return reject
        return yield* Deferred.await(deferred).pipe(
          Effect.timeout("30 seconds"),
          Effect.catch(() =>
            Effect.gen(function* () {
              repliedWaiters.delete(permissionRequestId)
              return "reject" as PermissionV2.Reply
            }),
          ),
        )
      })
    }

    return HdcPermissionPort.of({ evaluate, awaitApproval })
  }),
)

// ─── Fake Permission port for independent testing ──────────
// 可模拟 allow_once/always_allow/deny/timeout/saved_permission_failed 五种返回, 用于 SEC2 独立测试
// 真实区分 allow_once/always_allow/saved_permission_failed 的逻辑在 HdcPermissionAdapterLayer 中实现

export interface FakePermissionOptions {
  readonly evaluateResult?: "ask" | "allow" | "deny"
  readonly awaitApprovalResult?: "allow_once" | "always_allow" | "deny" | "timeout" | "saved_permission_failed"
}

export function FakePermissionPortLayerWithOptions(options: FakePermissionOptions): Layer.Layer<HdcPermissionPort> {
  const evalEffect = options.evaluateResult ?? "ask"
  const approvalEffect = options.awaitApprovalResult ?? "timeout"

  const evalReturn: PermissionResult =
    evalEffect === "allow"
      ? { effect: "allow", policySource: "saved_permission", approvalResult: "not_required", needsApproval: false }
      : evalEffect === "deny"
      ? { effect: "deny", policySource: "permission_config", approvalResult: "denied", needsApproval: false }
      : { effect: "ask", policySource: "product_default", approvalResult: "not_required", needsApproval: true, permissionRequestId: "fake-req-id" }

  const approvalReturn: PermissionResult =
    approvalEffect === "allow_once"
      ? { effect: "allow", policySource: "one_time_approval", approvalResult: "allow_once", needsApproval: false }
      : approvalEffect === "always_allow"
      ? { effect: "allow", policySource: "saved_permission", approvalResult: "always_allow", needsApproval: false }
      : approvalEffect === "deny"
      ? { effect: "deny", policySource: "product_default", approvalResult: "denied", needsApproval: false }
      : approvalEffect === "saved_permission_failed"
      ? { effect: "deny", policySource: "product_default", approvalResult: "denied", needsApproval: false, savedPermissionFailed: true }
      : { effect: "deny", policySource: "product_default", approvalResult: "denied", needsApproval: false, timedOut: true }

  return Layer.succeed(HdcPermissionPort, {
    evaluate: () => Effect.succeed(evalReturn),
    awaitApproval: () => Effect.succeed(approvalReturn),
  })
}

// 默认 Fake 层: evaluate=ask, awaitApproval=timeout (用于验证 fail-closed)
export const FakePermissionPortLayer = FakePermissionPortLayerWithOptions({})
