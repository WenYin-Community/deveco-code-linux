import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { LocalCrypto } from "@/security/local-crypto"
import { ACCESS_TOKEN_EXPIRES_MS, devecoAuth, saveAuthToDisk } from "../deveco"
import { getCurrentImprovementConsent } from "../deveco/improvement-consent"
import { redactAnalyticsEventPaths } from "./path-redaction"
import {
  ackPendingEvents,
  clearPendingEvents,
  enqueuePendingEvent,
  getAnalyticsMagpieEnabled,
  getOrCreatePathRedactionSalt,
  getPendingEvents,
  isMagpieAnalyticsEvent,
  preparePendingBatch,
  removePendingEvent,
} from "./storage"
import type { EnqueuedMagpieAnalyticsEvent, PendingMagpieAnalyticsEvent } from "./storage"
import { MAGPIE_ANALYTICS_ACTION, MAGPIE_DEFAULT_CONFIG } from "./types"
import type { AnalyticsConfig, AnalyticsEvent, HuaweiTracePayload } from "./types"

// 日志路径在**调用时**解析，而不是模块加载时快照 Global.Path.data：测试把
// Global.Path.data 指到临时目录后日志才会落进临时目录（与 storage.ts 的
// getAnalyticsFilePath() 同一处理方式），生产环境行为不变。
function analyticsLogFile(): string {
  return path.join(Global.Path.data, "analytics", "log", "analytics-magpie.log")
}

export interface UploadResult {
  success: boolean
  error?: string
}

export interface AuthInfo {
  type: string
  access?: string
  refresh?: string
  expires?: number
  key?: string
}

export interface ResolveMagpieAnalyticsAuthInput {
  authInfo: AuthInfo | undefined
  now: number
  refreshToken(): Promise<{ accessToken: string; refreshToken: string; isRealName: boolean } | null>
  saveAuth(providerID: string, info: Record<string, unknown>): Promise<void>
  diagnostic(message: string): Promise<void>
}

export interface UploaderDependencies {
  enqueuePendingEvent(event: AnalyticsEvent, maxQueueSize: number): Promise<EnqueuedMagpieAnalyticsEvent>
  removePendingEvent(queueId: string): Promise<number>
  clearPendingEvents(): Promise<void>
  getPendingEvents(): Promise<PendingMagpieAnalyticsEvent[]>
  /**
   * 取一批待上传事件：先按 queueId 过滤掉 exclude，再 slice(0, limit)，且只对
   * 真正进入 batch 的项置 sealed。上传侧用它把「本 build 读不懂的 payload」
   * 排除出本轮，同时不把它们从队列里删掉。
   */
  preparePendingBatch(limit: number, exclude?: readonly string[]): Promise<PendingMagpieAnalyticsEvent[]>
  ackPendingEvents(uploaded: readonly PendingMagpieAnalyticsEvent[]): Promise<number>
  redactEvent(event: AnalyticsEvent): Promise<AnalyticsEvent>
  /**
   * 三态同意读取：granted / declined / undefined。
   *
   * undefined 是「无从判断」（未登录、已登出、token 解不出 userId、账号没有
   * 同意记录），与「用户明确拒绝」是两件事 —— 上传门必须区分，否则登出就会
   * 清空整队（F3）。可选：未注入时退回 isEnabled 的严格布尔语义。
   */
  consent?(): Promise<"granted" | "declined" | undefined>
  isEnabled(): Promise<boolean>
  getAuthToken(): Promise<string | null>
  fetch: typeof globalThis.fetch
}

async function safeDiagnostic(input: ResolveMagpieAnalyticsAuthInput, message: string): Promise<void> {
  try {
    await input.diagnostic(message)
  } catch {
    // Magpie diagnostics must never affect authentication or product behavior.
  }
}

async function writeMagpieLog(message: string): Promise<void> {
  try {
    const file = analyticsLogFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, "utf8")
  } catch {
    // Magpie logging must never affect the DevEco Code process.
  }
}

/**
 * 服务端错误文本摘要：压成单行并截断 200 字符，供 !response.ok 的日志使用。
 *
 * 只在这里读 body —— 且只在失败分支读。读 body 自身也可能抛（流已消费、连接被断），
 * 因此整段 try/catch，返回占位串而不是让异常冒泡：日志绝不能改变上传的返回值语义。
 *
 * 隐私红线的关键：网关/服务端报错时**可能回显请求体**，而请求体里就是
 * `detail: JSON.stringify(event)`（含 query / answer / projectId）。日志是明文
 * appendFileSync，一旦回显就等于把用户代码片段写进日志。所以命中事件正文字段名
 * 时整段丢弃，只保留状态码信息。
 */
async function responseBodySnippet(response: Response): Promise<string> {
  try {
    const body = (await response.text()).replace(/\s+/g, " ").trim()
    if (!body) return "<empty>"
    if (ECHOED_EVENT_FIELDS.test(body)) return "<redacted-echo>"
    return body.length > 200 ? `${body.slice(0, 200)}…` : body
  } catch {
    return "<unreadable>"
  }
}

/**
 * 服务端错误体里一旦出现这些键名，就说明它把请求体回显了（请求体的 detail 含
 * query / answer / 文件列表）。只做「命中即整段丢弃」，不做局部脱敏 —— 局部的
 * 正则替换容易漏掉转义后的变体，而丢弃整段错误文本的排障损失可以接受。
 */
const ECHOED_EVENT_FIELDS = /"(query|answer|prompt|messages|detail|modifiedFileList|projectId|bundleName)"\s*:/i

function readAuthFromDisk(providerID: string): AuthInfo | undefined {
  try {
    const encrypted = JSON.parse(fs.readFileSync(path.join(Global.Path.data, "auth.json"), "utf8")) as Record<
      string,
      unknown
    >
    return LocalCrypto.decryptAuthData(encrypted)[providerID] as AuthInfo | undefined
  } catch {
    return undefined
  }
}

export async function resolveMagpieAnalyticsAuth(input: ResolveMagpieAnalyticsAuthInput): Promise<string | null> {
  const authInfo = input.authInfo
  if (authInfo?.type === "api") {
    if (authInfo.key) return authInfo.key
    await safeDiagnostic(input, "Authentication unavailable: access token missing")
    return null
  }
  if (authInfo?.type !== "oauth") {
    await safeDiagnostic(input, "Authentication unavailable: access token missing")
    return null
  }

  const tokenExpires = authInfo.expires || 0
  if (authInfo.access && (!tokenExpires || input.now < tokenExpires)) return authInfo.access

  await safeDiagnostic(input, "JWT refresh attempt")
  const refreshed = await input.refreshToken()
  if (!refreshed) {
    await safeDiagnostic(input, "JWT refresh failed")
    return null
  }
  await input.saveAuth("deveco", {
    type: "oauth",
    access: refreshed.accessToken,
    refresh: refreshed.refreshToken,
    expires: input.now + ACCESS_TOKEN_EXPIRES_MS,
    isRealName: refreshed.isRealName,
  })
  await safeDiagnostic(input, "JWT refresh succeeded")
  return refreshed.accessToken
}

const defaultDependencies: UploaderDependencies = {
  enqueuePendingEvent,
  removePendingEvent,
  clearPendingEvents,
  getPendingEvents,
  preparePendingBatch,
  ackPendingEvents,
  redactEvent: async (event) =>
    redactAnalyticsEventPaths(event, {
      salt: await getOrCreatePathRedactionSalt(),
    }),
  consent: getCurrentImprovementConsent,
  isEnabled: getAnalyticsMagpieEnabled,
  getAuthToken: () => {
    const authInfo = readAuthFromDisk("deveco")
    return resolveMagpieAnalyticsAuth({
      authInfo,
      now: Date.now(),
      refreshToken: () => devecoAuth.refreshToken(),
      saveAuth: (key, value) => saveAuthToDisk(key, value, authInfo?.access),
      diagnostic: writeMagpieLog,
    })
  },
  fetch: globalThis.fetch,
}

export function transformMagpieAnalyticsEvent(event: AnalyticsEvent, timestamp = Date.now()): HuaweiTracePayload {
  if (!isMagpieAnalyticsEvent(event)) throw new Error("Invalid Magpie analytics event")
  return {
    action: MAGPIE_ANALYTICS_ACTION,
    detail: JSON.stringify(event),
    timestamp,
  }
}

export const toHuaweiTracePayload = transformMagpieAnalyticsEvent

export class MagpieAnalyticsUploader {
  private readonly config: AnalyticsConfig
  private readonly dependencies: UploaderDependencies
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private abortController: AbortController | null = null
  private activeFlush: Promise<UploadResult> | null = null
  private enablePromise: Promise<void> | null = null
  private retryCount = 0
  private queueLength = 0
  /**
   * 是否已经为「同意状态未知」打过那条聚合日志。flush 是周期性的（默认 30s），
   * 每次未知状态都打日志会把日志刷爆，因此只在进入该状态的那一次记录。
   */
  private consentPaused = false
  /**
   * 上一轮「读不懂的待上传条数」，用于让 skip 日志只在变化时打一条：
   * 队列被 30 条坏数据堵住时，flush 每 30s 跑一次，逐轮打日志会把日志刷爆。
   */
  private skippedUnreadable = 0
  private generation = 0
  private disabled = true
  private restored = false
  private shuttingDown = false

  constructor(config: Partial<AnalyticsConfig> = {}, dependencies: Partial<UploaderDependencies> = {}) {
    this.config = { ...MAGPIE_DEFAULT_CONFIG, ...config }
    this.dependencies = { ...defaultDependencies, ...dependencies }
  }

  private async writeLog(message: string): Promise<void> {
    await writeMagpieLog(message)
  }

  private async readEnabled(): Promise<boolean> {
    try {
      return await this.dependencies.isEnabled()
    } catch {
      await this.writeLog("Failed to read Magpie switch; using the default enabled state")
      return true
    }
  }

  /**
   * 读三态同意。未注入 consent 依赖时退回严格布尔 isEnabled（旧行为），
   * 保证只覆盖了 isEnabled 的外部调用方语义不变。
   */
  private async readConsent(): Promise<"granted" | "declined" | undefined> {
    if (!this.dependencies.consent) return (await this.readEnabled()) ? "granted" : "declined"
    try {
      return await this.dependencies.consent()
    } catch {
      // 读失败等价于「不知道」：既不能当同意（会采集），也不能当拒绝（会清空队列），
      // 按 undefined 保留队列并等待下一轮。
      await this.writeLog("Failed to read Magpie consent state; treating it as unknown")
      return undefined
    }
  }

  /** 队列条数快照；读失败按 0 —— 日志里的数字不能因为读盘失败而抛错。 */
  private async countPendingEvents(): Promise<number> {
    try {
      return (await this.dependencies.getPendingEvents()).length
    } catch {
      return 0
    }
  }

  /**
   * 三态上传门：true 表示本轮继续（接收新事件 / 执行上传）。
   *
   * - granted → 继续。
   * - declined → 用户明确拒绝，清空并关闭，无可争议。
   * - undefined → **不清空、不上传**。这是本修复的核心（F3）：undefined 不是
   *   「拒绝」。旧实现把 !isEnabled 一律当成 disabled 走 disableAndClear()，
   *   于是未登录 / 登出 / 换账号期间队列被静默清空，而清空是不可恢复的。
   *   真正的隐私边界是 collector 侧的账号门（ensureEligible 要求账号非空且该
   *   账号同意），所以上传侧把事件留在磁盘上既不采集也不丢失。
   */
  private async consentAllowsUpload(): Promise<boolean> {
    const consent = await this.readConsent()
    if (consent === "granted") {
      this.consentPaused = false
      return true
    }
    if (consent === "declined") {
      await this.disableAndClear("consent declined")
      return false
    }
    await this.pauseUnknownConsent()
    return false
  }

  /**
   * 同意状态未知时静默等待，只在状态变化时打一条带保留条数的聚合日志。
   *
   * 不走 recordFailure / scheduleRetry：那不是「上传失败」，把「此刻没有账号」
   * 当成可重试错误只会换来无意义的指数退避重试（每次仍失败），而且会在日志里
   * 反复刷屏。
   */
  private async pauseUnknownConsent(): Promise<void> {
    if (this.consentPaused) return
    this.consentPaused = true
    const retained = await this.countPendingEvents()
    await this.writeLog(`Magpie upload paused: consent unknown; ${retained} pending event(s) retained`)
  }

  async restorePending(): Promise<void> {
    try {
      this.queueLength = (await this.dependencies.getPendingEvents()).length
      this.restored = true
      if (this.queueLength) await this.writeLog(`Restored ${this.queueLength} pending event(s) from disk`)
    } catch {
      this.queueLength = 0
      await this.writeLog("Failed to restore pending events")
    }
  }

  private async activate(): Promise<void> {
    const generation = ++this.generation
    this.disabled = false
    this.shuttingDown = false
    try {
      const queueLength = (await this.dependencies.getPendingEvents()).length
      if (this.disabled || generation !== this.generation) return
      this.queueLength = queueLength
      this.restored = true
      if (queueLength) await this.writeLog(`Restored ${queueLength} pending event(s) from disk`)
      if (this.disabled || generation !== this.generation) return
      this.startPeriodicFlush()
    } catch {
      if (this.disabled || generation !== this.generation) return
      this.queueLength = 0
      await this.writeLog("Failed to restore pending events")
      this.startPeriodicFlush()
    }
  }

  async enable(): Promise<void> {
    if (!this.config.enabled) return
    if (!this.disabled && this.restored) {
      this.startPeriodicFlush()
      return
    }
    if (this.enablePromise) return this.enablePromise

    const activation = this.activate()
    this.enablePromise = activation
    try {
      await activation
    } finally {
      if (this.enablePromise === activation) this.enablePromise = null
    }
  }

  /**
   * 关闭采集并清空队列。
   *
   * reason 与清空条数都要落日志（F2）：旧实现只清空、不记原因也不记条数，
   * 事后只能看到「事件凭空消失」。清空前先取一次队列长度（读失败按 0），
   * 这样日志里的数字是真实被丢弃的量。
   */
  async disableAndClear(reason = "collection disabled"): Promise<void> {
    this.disabled = true
    this.restored = false
    this.generation++
    this.enablePromise = null
    this.stopPeriodicFlush()
    this.cancelRetry()
    this.abortController?.abort()
    this.abortController = null
    this.queueLength = 0
    this.retryCount = 0
    this.consentPaused = false
    const cleared = await this.countPendingEvents()
    try {
      await this.dependencies.clearPendingEvents()
    } catch {
      await this.writeLog("Failed to clear Magpie pending events while disabling")
    }
    await this.writeLog(`Magpie collection disabled (${reason}); cleared ${cleared} pending event(s)`)
  }

  async upload(event: AnalyticsEvent): Promise<boolean> {
    const generation = await this.admitUpload()
    if (generation === undefined || !(await this.persistEvent(event, generation))) return false
    if (this.queueLength >= this.config.batchSize) await this.flush()
    return true
  }

  private async admitUpload(): Promise<number | undefined> {
    if (!this.config.enabled || this.shuttingDown) return undefined
    const admissionGeneration = this.generation
    // declined 已在门内关闭并清空；undefined 只是拒绝接收新事件，**不做任何清理**。
    if (!(await this.consentAllowsUpload())) return undefined
    if (this.shuttingDown || admissionGeneration !== this.generation) return undefined
    if (this.disabled) await this.enable()
    return this.disabled || this.shuttingDown ? undefined : this.generation
  }

  private async persistEvent(event: AnalyticsEvent, generation: number): Promise<boolean> {
    try {
      const redacted = await this.dependencies.redactEvent(event)
      if (this.disabled || generation !== this.generation) return false
      const enqueued = await this.dependencies.enqueuePendingEvent(redacted, this.config.maxQueueSize)
      if (this.disabled || generation !== this.generation) {
        // 入队与关闭采集并发时的补偿删除。旧实现静默 remove，事件无声消失；
        // 这里补一条日志，让「为什么队列里少了一条」可追溯（F2）。
        await this.dependencies.removePendingEvent(enqueued.queueId).catch(() => undefined)
        await this.writeLog("Magpie discarded an event queued concurrently with a collection shutdown")
        return false
      }
      this.queueLength = enqueued.queueLength
      await this.writeLog(`Magpie event queued: count=${this.queueLength}`)
    } catch {
      await this.writeLog("Failed to redact or persist Magpie event")
      return false
    }
    return true
  }

  private cancelRetry(): void {
    if (!this.retryTimer) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private scheduleRetry(): void {
    if (this.disabled || this.shuttingDown || this.retryTimer || this.config.maxRetries <= 0) return
    if (this.retryCount > this.config.maxRetries) {
      this.retryCount = 0
      void this.writeLog("Magpie retry limit reached; durable pending events retained for the next flush cycle")
      return
    }

    const delay = this.config.retryDelay * 2 ** Math.min(Math.max(0, this.retryCount - 1), 10)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.disabled || this.shuttingDown) return
      void this.flush()
    }, delay)
    this.retryTimer.unref?.()
  }

  private async recordFailure(message: string): Promise<void> {
    this.retryCount++
    await this.writeLog(message)
    this.scheduleRetry()
  }

  // 扫一遍队列，返回本 build 读不懂的 queueId。
  //
  // 为什么不能直接 batch.slice()：队头若有本 build 读不懂的 payload（旧版本写法留下的
  // 字段、被上游改坏的事件），它会让整批 transform 抛错，于是队列永远卡在队头 ——
  // 一条坏数据堵死所有好数据。
  // 为什么不删掉读不懂的那条：它可能是更新版本写的、本 build 只缺解析能力的事件，
  // 删掉就是永久丢数据（且很难被发现）。所以这里只把它排除出本轮选择，留在队列里交给
  // 更新的客户端上传；真到了容量上限，由 enqueue 的最老淘汰自然清理。
  //
  // 一次扫完整个队列再排除，而不是「每轮跳 batchSize 条、最多跳 3 轮」：后者的上限是
  // 3×batchSize（默认 30）条，30 条连续的坏数据就能把后面所有好数据永久挡在外面
  // （实测 requests=0，只能等队列涨到 1000 条被最老淘汰才自愈）。
  private async collectUnreadable(): Promise<string[]> {
    const pending = await this.dependencies.getPendingEvents()
    const unreadable = pending.filter((item) => !isMagpieAnalyticsEvent(item.event)).map((item) => item.queueId)
    this.queueLength = pending.length
    if (unreadable.length !== this.skippedUnreadable) {
      this.skippedUnreadable = unreadable.length
      if (unreadable.length) {
        await this.writeLog(
          `Magpie skipped ${unreadable.length} unreadable pending event(s); retained for a newer client`,
        )
      }
    }
    return unreadable
  }

  private async flushOnce(): Promise<UploadResult> {
    if (this.disabled) return { success: true }
    // 三态门：declined 已在门内清空；undefined 时保留队列并返回成功 ——
    // 不是上传失败，不能触发 recordFailure / scheduleRetry（否则重试风暴）。
    if (!(await this.consentAllowsUpload())) return { success: true }

    const generation = this.generation
    // 取批：先扫一遍队列算出让本 build 读不懂的 queueId，再让存储层排除它们。
    const unreadable = await this.collectUnreadable()
    const uploadable = await this.dependencies.preparePendingBatch(this.config.batchSize, unreadable)
    if (!uploadable.length) return { success: true }

    const authToken = await this.dependencies.getAuthToken()
    if (!authToken) {
      await this.recordFailure("Authentication unavailable: Magpie pending events retained")
      return { success: false, error: "Authentication unavailable" }
    }
    if (this.disabled || generation !== this.generation) return { success: true }

    const payload = await Promise.all(
      uploadable.map(async (pending) =>
        transformMagpieAnalyticsEvent(await this.dependencies.redactEvent(pending.event)),
      ),
    )
    if (this.disabled || generation !== this.generation) return { success: true }

    const controller = new AbortController()
    this.abortController = controller
    const response = await this.dependencies.fetch(this.config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: authToken },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (this.abortController === controller) this.abortController = null
    if (this.disabled || generation !== this.generation) return { success: true }
    if (!response.ok) {
      // 失败日志带上服务端错误文本摘要（单行、截断 200 字符）：
      // 只记状态码无法区分「服务端 5xx 抖动」和「载荷被拒」，排查时无从下手。
      const body = await responseBodySnippet(response)
      await this.recordFailure(
        `Magpie upload failed: HTTP ${response.status}, ${uploadable.length} event(s) retained; body=${body}`,
      )
      return { success: false, error: `HTTP ${response.status}` }
    }

    this.queueLength = await this.dependencies.ackPendingEvents(uploadable)
    this.retryCount = 0
    this.cancelRetry()
    await this.writeLog(`Magpie upload succeeded: HTTP ${response.status}, ${uploadable.length} event(s)`)
    return { success: true }
  }

  async flush(): Promise<UploadResult> {
    if (this.disabled) return { success: true }
    if (this.activeFlush) return this.activeFlush
    this.cancelRetry()

    const running = this.flushOnce().catch(async (error) => {
      if (this.disabled || (error instanceof Error && error.name === "AbortError")) return { success: true }
      const message = error instanceof Error ? error.message : String(error)
      await this.recordFailure(`Magpie upload failed: ${message}; pending events retained`)
      return { success: false, error: message }
    })
    this.activeFlush = running
    try {
      return await running
    } finally {
      if (this.activeFlush === running) this.activeFlush = null
      this.abortController = null
    }
  }

  getQueueLength(): number {
    return this.queueLength
  }

  startPeriodicFlush(): void {
    if (this.disabled || this.shuttingDown || this.flushTimer) return
    this.flushTimer = setInterval(() => {
      if (this.retryTimer) return
      void this.flush()
    }, this.config.flushInterval)
    this.flushTimer.unref?.()
  }

  stopPeriodicFlush(): void {
    if (!this.flushTimer) return
    clearInterval(this.flushTimer)
    this.flushTimer = null
  }

  async shutdown(): Promise<void> {
    this.stopPeriodicFlush()
    this.cancelRetry()
    this.shuttingDown = true
    if (this.activeFlush) {
      this.disabled = true
      this.generation++
      this.abortController?.abort()
      this.abortController = null
      return
    }
    if (!this.disabled && this.queueLength > 0) await this.flushOnce().catch(() => ({ success: false }))
    this.disabled = true
    this.generation++
    this.abortController?.abort()
    this.abortController = null
  }
}

export const globalUploader = new MagpieAnalyticsUploader()

export async function uploadAnalyticsEvent(event: AnalyticsEvent): Promise<boolean> {
  return globalUploader.upload(event)
}

export async function flushAnalyticsEvents(): Promise<UploadResult> {
  return globalUploader.flush()
}

export async function enableAnalyticsMagpie(): Promise<void> {
  return globalUploader.enable()
}

export async function disableAnalyticsMagpie(): Promise<void> {
  // 传具体原因：登出与「用户关掉开关」都会清空队列，日志必须能区分，否则事后
  // 只看到「事件凭空消失」。这条路径是产品决定（登出后不留上一个账号的事件），
  // 不是 bug；写进日志是为了让它在现场可识别。
  return globalUploader.disableAndClear("logout")
}
