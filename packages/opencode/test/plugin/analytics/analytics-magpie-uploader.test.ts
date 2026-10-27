/**
 * Magpie uploader 的上传门（F3）与清空/失败日志（F2）。
 *
 * 回归目标（F3）：上传门过去读的是严格布尔 isEnabled（consent === "granted"）。
 * 而 getCurrentImprovementConsent() 在「未登录 / 已登出 / token 解不出 userId /
 * 账号没有同意记录」时返回 undefined —— 上传门把这种「无从判断」当成「用户拒绝」
 * 调 disableAndClear()，于是整队持久事件被静默清空。未知不等于拒绝，队列必须
 * 在这种情况下原样保留。
 *
 * 同时钉住 F2 的日志契约：清空要说清原因与丢弃条数；上传失败要带上服务端错误
 * 文本摘要（单行、截断 200 字符）。
 */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { LocalCrypto } from "@/security/local-crypto"
import {
  enqueuePendingEvent,
  getPendingEvents,
  MAGPIE_ANALYTICS_STORAGE_SCHEMA_VERSION,
} from "@/plugin/analytics-magpie/storage"
import { MagpieAnalyticsUploader } from "@/plugin/analytics-magpie/uploader"
import type { UploaderDependencies } from "@/plugin/analytics-magpie/uploader"
import type { AnalyticsEvent } from "@/plugin/analytics-magpie/types"
import { MAGPIE_ANALYTICS_ACTION } from "@/plugin/analytics-magpie/types"
import { tmpdir } from "../../fixture/fixture"

const originalDataDir = Global.Path.data
const activeUploaders: MagpieAnalyticsUploader[] = []

afterEach(() => {
  // 定时器是 unref 过的，不会挂住进程；这里显式停掉只是为了测试之间互不干扰。
  activeUploaders.splice(0).forEach((uploader) => uploader.stopPeriodicFlush())
  Global.Path.data = originalDataDir
})

/** 通过 isMagpieAnalyticsEvent 校验的最小 magpie 事件（必填字段齐全）。 */
function magpieEvent(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    analyticsSchemaVersion: 2,
    analyticsStream: "magpie",
    pathRedactionVersion: 1,
    pathRedactionMode: "hmac-sha256-installation",
    sourceType: "DevEco-Code-Plugin",
    sourceVersion: "6.0.1.100",
    os_arch: "arm64",
    os_name: process.platform,
    os_version: "os-version",
    providerId: "deveco",
    modelId: "model-1",
    sessionid: "session-1",
    messageId: "message-1",
    agentName: "build",
    query: "query",
    answer: "answer",
    inputTokens: 1,
    outputTokens: 1,
    cacheTokens: 14960,
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    bundleName: "",
    modifiedFileList: [],
    operations: { builtinTools: [], mcpTools: [], skillTools: [] },
    toolExecutions: [],
    isSuccess: true,
    totalElapsed: 10,
    firstResultElapsed: 5,
    startedAt: 1,
    assistantExecutions: [],
    ...overrides,
  }
}

/**
 * uploader 的日志落在 Global.Path.data/analytics/log/analytics-magpie.log。
 * 因为 uploader 在写日志时**才**解析路径，测试把 Global.Path.data 指向临时目录
 * 后即可直接读，不污染真实用户数据目录。
 */
async function readLog(): Promise<string> {
  try {
    return await fs.readFile(path.join(Global.Path.data, "analytics", "log", "analytics-magpie.log"), "utf8")
  } catch {
    return ""
  }
}

/**
 * 直接落盘一个队列文件（含完整信封），用于构造「本 build 读不懂的 payload」。
 *
 * 为什么不用 enqueuePendingEvent 造这种事件：入队口自己就校验 isMagpieAnalyticsEvent，
 * 非法事件根本进不了队列。但真实世界存在这种数据 —— 更新的客户端写进来、或者旧版本
 * 的键名/类型，所以必须能模拟「读回时信封合法、payload 读不懂」的状态。
 */
async function stageQueue(entries: { queueId: string; event: unknown }[]): Promise<void> {
  const file = path.join(Global.Path.data, "analytics", "analytics-magpie.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify(
      LocalCrypto.encryptForLocalStorage(
        JSON.stringify({
          schemaVersion: MAGPIE_ANALYTICS_STORAGE_SCHEMA_VERSION,
          pendingEvents: entries.map((entry) => ({
            action: MAGPIE_ANALYTICS_ACTION,
            event: entry.event,
            queueId: entry.queueId,
            sealed: false,
          })),
          lastFlush: 1,
        }),
      ),
    ),
  )
}

/** 读回磁盘上的队列原文：断言 ack / 删除 / sealed 是否真的落盘，而不是只看内存。 */
async function readQueue(): Promise<{ queueId: string; sealed: boolean; event: Record<string, unknown> }[]> {
  const file = path.join(Global.Path.data, "analytics", "analytics-magpie.json")
  const persisted = JSON.parse(await fs.readFile(file, "utf8"))
  const plain = LocalCrypto.isEncryptedBlob(persisted)
    ? JSON.parse(LocalCrypto.decryptForLocalStorage(persisted))
    : persisted
  return plain.pendingEvents
}

type Consent = "granted" | "declined" | undefined

interface UploadHarness {
  uploader: MagpieAnalyticsUploader
  /** 每次 fetch 的请求体（JSON 字符串），元素个数即上传轮次数。 */
  requests: string[]
}

/**
 * 直接 new MagpieAnalyticsUploader：队列走**真实** storage（Global.Path.data 已
 * 指向临时目录），只桩掉网络、鉴权、脱敏与同意读取。用真实 storage 才能断言
 * 「队列真的被清空 / 真的保留」——这正是 F3 的证据。
 */
async function createUploader(input: {
  consent: () => Promise<Consent>
  respond?: () => Response
}): Promise<UploadHarness> {
  const requests: string[] = []
  // Bun 的 typeof fetch 还带一个 preconnect 方法，所以桩函数用 Object.assign 补齐
  // （与 test/provider/cf-ai-gateway-e2e.test.ts 的同一做法），而不是 as any。
  const stubFetch: typeof globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(typeof init?.body === "string" ? init.body : "")
      return input.respond?.() ?? new Response("", { status: 200 })
    },
    { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) },
  )
  const dependencies: Partial<UploaderDependencies> = {
    consent: input.consent,
    getAuthToken: async () => "test-token",
    redactEvent: async (event) => event,
    fetch: stubFetch,
  }
  const uploader = new MagpieAnalyticsUploader(
    // maxRetries=0：失败分支不排重试定时器，测试也不必等退避延时。
    { batchSize: 10, flushInterval: 3_600_000, maxQueueSize: 100, maxRetries: 0, retryDelay: 1 },
    dependencies,
  )
  await uploader.enable()
  activeUploaders.push(uploader)
  return { uploader, requests }
}

describe("magpie uploader consent gate", () => {
  test("keeps the queue when consent is unknown instead of clearing it", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await enqueuePendingEvent(magpieEvent())
    await enqueuePendingEvent(magpieEvent({ sessionid: "session-2" }))
    await enqueuePendingEvent(magpieEvent({ sessionid: "session-3" }))

    const { uploader, requests } = await createUploader({ consent: async () => undefined })
    const result = await uploader.flush()

    expect(result).toEqual({ success: true })
    expect(requests).toHaveLength(0)
    // 关键证据：队列在磁盘上原封不动（旧实现在这里会变成 0 条）。
    expect(await getPendingEvents()).toHaveLength(3)
    const log = await readLog()
    expect(log).toContain("Magpie upload paused: consent unknown; 3 pending event(s) retained")
    expect(log).not.toContain("cleared")
  })

  test("pauses silently without repeated retries while consent stays unknown", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await enqueuePendingEvent(magpieEvent())

    const { uploader } = await createUploader({ consent: async () => undefined })
    // 连续 flush 三次：解析式聚合日志只允许出现一次，且不能出现重试/失败字样
    // （否则周期 flush 会在未登录期间刷屏并堆出退避重试）。
    await uploader.flush()
    await uploader.flush()
    await uploader.flush()

    const log = await readLog()
    expect(log.split("Magpie upload paused: consent unknown").length - 1).toBe(1)
    expect(log).not.toContain("Magpie upload failed")
    expect(log).not.toContain("retry limit")
    expect(await getPendingEvents()).toHaveLength(1)
  })

  test("clears the queue when consent is declined and records why", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await enqueuePendingEvent(magpieEvent())
    await enqueuePendingEvent(magpieEvent({ sessionid: "session-2" }))

    const { uploader, requests } = await createUploader({ consent: async () => "declined" })
    const result = await uploader.flush()

    expect(result).toEqual({ success: true })
    expect(requests).toHaveLength(0)
    expect(await getPendingEvents()).toHaveLength(0)
    expect(await readLog()).toContain("Magpie collection disabled (consent declined); cleared 2 pending event(s)")
  })

  test("uploads and acks the batch when consent is granted", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await enqueuePendingEvent(magpieEvent())

    const { uploader, requests } = await createUploader({ consent: async () => "granted" })
    const result = await uploader.flush()

    expect(result).toEqual({ success: true })
    expect(requests).toHaveLength(1)
    const payload = JSON.parse(requests[0]) as { action: string }[]
    expect(payload).toHaveLength(1)
    expect(payload[0].action).toBe(MAGPIE_ANALYTICS_ACTION)
    expect(await getPendingEvents()).toHaveLength(0)
    expect(await readLog()).toContain("Magpie upload succeeded: HTTP 200, 1 event(s)")
  })
})

describe("magpie uploader failure logging", () => {
  test("retains the queue and logs the server error text on HTTP failure", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await enqueuePendingEvent(magpieEvent())

    const { uploader } = await createUploader({
      consent: async () => "granted",
      respond: () => new Response("rejected: cacheTokens missing\n  (trace 42)", { status: 500 }),
    })
    const result = await uploader.flush()

    expect(result).toEqual({ success: false, error: "HTTP 500" })
    // 失败不清队：事件必须留待下次重试。
    expect(await getPendingEvents()).toHaveLength(1)
    const log = await readLog()
    // 状态码 + 保留条数 + 单行化的服务端错误文本，全在同一条日志里。
    expect(log).toContain(
      "Magpie upload failed: HTTP 500, 1 event(s) retained; body=rejected: cacheTokens missing (trace 42)",
    )
    // 隐私红线：日志里绝不能出现事件正文。
    expect(log).not.toContain('"query"')
    expect(log).not.toContain("550e8400")
  })

  test("drops the server error text when the server echoes the request body", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await enqueuePendingEvent(magpieEvent())

    // 真实网关报错时经常把请求体回显在 detail 里，而请求体含 query / answer：
    // 摘要必须整段丢弃，只留状态码与保留条数。
    const { uploader } = await createUploader({
      consent: async () => "granted",
      respond: () =>
        new Response(
          JSON.stringify({ errorCode: 4001, detail: JSON.stringify({ query: "secret-code", answer: "x" }) }),
          {
            status: 400,
          },
        ),
    })
    const result = await uploader.flush()

    expect(result).toEqual({ success: false, error: "HTTP 400" })
    const log = await readLog()
    expect(log).toContain("Magpie upload failed: HTTP 400, 1 event(s) retained; body=<redacted-echo>")
    expect(log).not.toContain("secret-code")
    expect(log).not.toContain('"query"')
  })
})

describe("magpie uploader unreadable payloads", () => {
  test("skips an unreadable payload instead of blocking or deleting the queue", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    // 最老一条：信封完整（storage 层只校验信封，所以能安全读回），但 payload 里 query
    // 是数字 —— 本 build 的 isMagpieAnalyticsEvent 判定它读不懂。它后面跟一条合法事件。
    // 这里刻意不用 cacheTokens 缺失来构造非法：那是 token 字段口径之争，与「读不懂的
    // payload」这条上传侧行为无关。
    const unreadable: Record<string, unknown> = { ...magpieEvent(), query: 123 }
    await stageQueue([
      { queueId: "bad-1", event: unreadable },
      { queueId: "good-1", event: magpieEvent() },
    ])

    const { uploader, requests } = await createUploader({ consent: async () => "granted" })
    // 契约是「最多 3 轮选择 + 跳过」：连续 flush 也不会多打请求，更不会卡死在队头。
    for (let round = 0; round < 3; round++) await uploader.flush()

    // 合法事件穿过队头被上传：只发出一次请求，payload 里只有 1 条。
    expect(requests).toHaveLength(1)
    const payload = JSON.parse(requests[0]) as { action: string }[]
    expect(payload).toHaveLength(1)
    expect(payload[0].action).toBe(MAGPIE_ANALYTICS_ACTION)

    // 读不懂的那条必须原样留在队列里（既不 ack、也不删除），合法那条已被 ack。
    const onDisk = await readQueue()
    expect(onDisk.map((entry) => entry.queueId)).toEqual(["bad-1"])
    expect(onDisk[0].event.query).toBe(123)
    expect((await getPendingEvents()).map((pending) => pending.queueId)).toEqual(["bad-1"])

    expect(await readLog()).toContain("Magpie skipped 1 unreadable pending event(s); retained for a newer client")
  })

  test("still reaches a readable event queued behind a long run of unreadable ones", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    // 30 条连续坏数据（> 3×batchSize），好事件排在最后。旧的「最多 3 轮、每轮跳
    // batchSize 条」实现只跳得到前 30 条，于是永远选中不了 good-1：实测 requests=0，
    // 队列只能等涨到上限被最老淘汰才自愈。现在一次扫完整个队列，好事件必须被上传。
    const unreadable = Array.from({ length: 30 }, (_, index) => ({
      queueId: `bad-${index}`,
      event: { ...magpieEvent(), query: 123 } as unknown as Record<string, unknown>,
    }))
    await stageQueue([...unreadable, { queueId: "good-1", event: magpieEvent() }])

    const { uploader, requests } = await createUploader({ consent: async () => "granted" })
    await uploader.flush()

    expect(requests).toHaveLength(1)
    expect((JSON.parse(requests[0]) as { action: string }[]).length).toBe(1)
    // 30 条坏的必须原样留在盘上（顺序与内容都不变），只 ack 成功上传的那条。
    const onDisk = await readQueue()
    expect(onDisk.map((entry) => entry.queueId)).toEqual(unreadable.map((entry) => entry.queueId))
    expect(onDisk[0].event.query).toBe(123)
  })

  test("logs the skip once instead of on every flush while the queue stays blocked", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await stageQueue([{ queueId: "bad-1", event: { ...magpieEvent(), query: 123 } }])

    const { uploader, requests } = await createUploader({ consent: async () => "granted" })
    // 队列里只有坏数据时 flush 是每 30s 跑一次的空转：日志必须只在状态变化时打一次，
    // 否则稳态下每天多出 2880 条同样的行。
    for (let round = 0; round < 3; round++) await uploader.flush()

    expect(requests).toHaveLength(0)
    const log = await readLog()
    expect(log.split("Magpie skipped 1 unreadable pending event(s)").length - 1).toBe(1)
  })
})
