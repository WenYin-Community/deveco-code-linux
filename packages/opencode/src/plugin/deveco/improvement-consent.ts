/**
 * Improvement 同意记录（账号级）—— 完整实现
 *
 * 职责：维护"某华为账号是否同意 Improvement 数据上报"这一状态，并提供
 *   - 账号指纹（匿名化后的账号标识，用于本地存储的键名）
 *   - 从本地登录凭据离线解析 userId（判定"当前是哪个账号"）
 *   - 存储原语（Flock + tmp/rename 的读改写，T0.2）
 *   - 三态判定与 30s TTL 缓存（T1.2）
 *   - 设备级遗留记录的惰性认领（一次性归属，D7 / T1.3）
 *
 * ── 依赖约束（ADR-1 / ADR-3，新增 import 前必读）─────────────────────────
 * 允许依赖：
 *   ./token-storage（叶子：LocalCrypto + Global + ./log）
 *   ./log（叶子：Effect 日志桥；已因 token-storage 处于本模块的传递依赖闭包，
 *     直接引用不扩大依赖面）
 *   @/cli/deveco-privacy-settings、@opencode-ai/core/*、@/security/local-crypto
 * 禁止依赖：
 *   ./auth、./login-service           —— 会把整套登录机制（region-policy / http-client / storage）拉进依赖图
 *   ../analytics-magpie/*             —— 本模块被 magpie/storage 引用，反向依赖会造成图变重
 *
 * 理由：本模块的调用方横跨三类上下文——SolidJS 组件（面板/弹窗/设置行，非 Effect）、
 *   auth-plugin 的自定义 fetch（非 Effect）、magpie 的依赖注入表（Effect 侧）。
 *   因此它被实现为**普通 async 模块**而非 Effect Service（同先例：./access.ts），
 *   并保持"只依赖叶子模块"的依赖瘦身。
 *
 * 注意：这不是为了"避免循环依赖"。经静态 import 图核对，login-service 对
 *   analytics-magpie/uploader 的引用是**动态** `await import()`（登出清理），
 *   静态图上并不存在环（设计 §9.1 的 S1 修正）。
 */

import { createHash, randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { readToolImprovementSetting } from "@/cli/deveco-privacy-settings"
import { logWarn } from "./log"
import { tokenStorage } from "./token-storage"

/**
 * 账号指纹：`SHA-256(userId)` 的十六进制取前 16 个字符（= 64 bit）。
 *
 * 为什么必须是确定性哈希：
 *   同意记录以指纹为键落盘。若同一账号在不同时刻/不同进程算出的指纹不同，
 *   就再也查不回已落盘的记录，用户会被反复询问。
 *
 * 为什么不加盐（重要取舍）：
 *   安装级随机盐会让**重装/换机器后**算出的指纹改变，记录随之"失效"，
 *   与 D4「同意/拒绝均永久有效」直接冲突。
 *   代价是：无盐哈希对可枚举的 userId（纯数字）可被反查——因此本项匿名化的
 *   目标是"**不在本地明文暴露**账号标识"（日志、支持包、备份、截图），
 *   **不是**抗本地枚举的安全边界（状态文件权限 0600，而能读它的主体同样能读
 *   token.enc / auth.json）。详见需求 F-12。
 *
 * 碰撞：单机 N 个账号的碰撞概率约 N²/2⁶⁵（N=100 时 ~3e-15），可忽略。
 */
export function accountFingerprint(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 16)
}

/**
 * 从 JWT 的 payload 段解析出 userId（最小解码，不校验签名）。
 *
 * 为什么不用 `devecoAuth.getUserId()`：
 *   不是为了避环（见文件头的说明），而是**依赖瘦身**——`devecoAuth` 会牵入
 *   auth → login-service → region-policy / http-client / storage 整套登录机制，
 *   而本模块只需要"从 token.enc 读一个 userId"。
 *   代价：与 `login-service.parseJwt` 重复约 6 行 base64 解码；若日后需要更多
 *   JWT 字段，应把 parseJwt 下沉到公共叶子模块供两边复用（设计 §8 第 19 项，可选）。
 *
 * 返回值：无法解析、payload 非对象、userId 缺失或为**空串**时返回 null。
 *   空串必须视为无效——否则会为 `accountFingerprint("")` 落盘一条无账号归属的记录。
 *
 * 注：此处用 try/catch 而非 Effect Schema，是因为本模块刻意不引入 Effect 运行时
 *   （调用方含非 Effect 上下文），且只解析这一个极窄的字段；同目录的
 *   token-storage.ts / storage.ts 也是这一写法。
 */
export function parseJwtUserId(token: string): string | null {
  // JWT 结构：header.payload.signature，payload 段是 base64url 编码的 JSON
  const part = token.split(".")[1]
  if (!part) return null
  try {
    // Buffer 的 "base64url" 解码对非法字符是宽容的（不抛错），
    // 因此下面 JSON.parse 才是真正的失败点
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown
    if (typeof payload !== "object" || payload === null) return null
    const userId = (payload as Record<string, unknown>).userId
    return typeof userId === "string" && userId.length > 0 ? userId : null
  } catch {
    // 非法 base64 / 非法 JSON 一律视为"解析不出账号"（调用方按未登录处理）
    return null
  }
}

/**
 * 从本地登录凭据（`token.enc` 里的 JWT）离线解析当前账号的 userId。
 *
 * 离线：`tokenStorage.loadToken()` 只做本地解密（LocalCrypto），不发网络请求。
 * 未登录或凭据损坏时返回 null（`loadToken` 在解密失败时会主动删除 token.enc）。
 *
 * 注意：`tokenStorage` 是**模块级单例**（其 token.enc 路径在模块加载时由
 *   `Global.Path.config` 求值），因此测试无法在同进程内重定向它——涉及
 *   "凭据不存在/被删除"的用例需在子进程里设置 `XDG_CONFIG_HOME`
 *   （见 test-cases.md 的测试隔离专项与 TC-RS-02 / TC-RS-08）。
 */
export async function loadUserIdFromDisk(): Promise<string | null> {
  const jwt = await tokenStorage.loadToken()
  return jwt ? parseJwtUserId(jwt) : null
}

// ── 同意记录的存储原语（T0.2）──────────────────────────────────────────────
//
// 载体：`<state>/improvement-consent.json`（**独立文件**，不复用 kv.json）
//   ADR-2：kv.json 存在"以 `tui-kv:<file>` 锁 + 读改写"为约定的写入者家族
//   （TUI 主进程、cli/upgrade.ts 的升级状态）。本模块的写入方含 worker（惰性认领）
//   与潜在 CLI、且分散在不同进程，另立文件可避免扩大该家族，也不受
//   upgrade.ts"读取失败以空对象起底"缺陷的影响。
//   先例：cli/deveco-product-agreement.ts（同为"同意"类状态的独立文件 + tmp/rename）

/** 同意记录文件结构（v1） */
export type ConsentFile = {
  schemaVersion: 1
  /** key = 账号指纹（见 accountFingerprint）；value = 该账号的明示表态 */
  accounts: Record<string, { granted: boolean; at: number }>
  /** D7：设备级遗留记录是否已被某账号认领（认领后不再参与判定） */
  legacyClaimed?: boolean
}

/** 路径与锁名**按 state 目录派生**（不设模块级常量），使测试可注入临时目录 */
const consentFile = (state: string) => path.join(state, "improvement-consent.json")
/** 独立锁名：与 kv.json 的 `tui-kv:` / `privacy-kv:` 互不相干（ADR-2） */
const consentLock = (file: string) => `improvement-consent:${file}`
/**
 * 锁文件目录**显式派生自 state**，不要依赖 `Flock` 的全局默认值：
 *   - `acquire()` 不传 `dir` 时用 `root()` = `global.state/locks`，而该全局值由
 *     `@opencode-ai/core/global` 在导入时 `Flock.setGlobal({ state })` 设置；
 *     未导入它时 `root()` 会**直接抛错**（"Flock global not set"）。
 *   - 显式传 `dir` 才能让测试注入的临时 state 目录**完全自包含**（否则锁文件会落到
 *     真实的全局 state 目录，污染本机并破坏测试隔离）。
 *   同先例：cli/deveco-agreement-sync.ts:76 也是显式传 `dir: <state>/locks`。
 */
const consentLockDir = (state: string) => path.join(state, "locks")

const emptyConsentFile = (): ConsentFile => ({ schemaVersion: 1, accounts: {} })

/**
 * 读取同意记录（**只读路径也持锁**）。
 *
 * 为什么读也要持锁：与写方互斥，避免读到"已改内存、尚未 rename"的中间状态。
 *   严格说 rename 的原子性已保证读不到半截文件，持锁是额外保险（成本可忽略）。
 *   注意这与 `test/cli/deveco-privacy-settings.test.ts` 里"读不等写锁"的哲学**相反**：
 *   那里读 kv.json，其写方（TUI）可能长时间持锁，故读取方刻意用**另一个**锁名；
 *   本文件的写方持锁极短（一次小文件写），读方排队是划算的。
 *
 * 任何读取失败（不存在 / 非法 JSON / 无权限）都回退为**空结构**：
 *   对同意语义而言"读不到"必须等价于"未表态"（会再问一次），
 *   绝不能被当成"已同意"。
 *
 * @internal 导出仅为测试；生产代码请用 T1.2 的对外 API。
 */
export async function readConsentFile(state: string): Promise<ConsentFile> {
  const file = consentFile(state)
  return Flock.withLock(
    consentLock(file),
    () =>
      Bun.file(file)
        .json()
        .then((data) => normalizeConsentFile(data))
        .catch(() => emptyConsentFile()),
    { dir: consentLockDir(state) },
  )
}

/**
 * 写原语：读最新 → 合并 → 临时文件 → rename（全程持锁）。
 *
 * 关键约束（ST-4）：整个"读-改-写"必须在**同一把锁内**完成。写入方跨进程
 *   （TUI 主进程确认勾选、worker 惰性认领、CLI），任何一方裸写都会丢其它方的更新。
 *   先例：`tui/src/context/kv.tsx` 的 `set()`、`cli/deveco-product-agreement.ts`。
 *
 * 返回**写入后的最终结构**：调用方需要认领结果，不能只看自己手里的旧快照
 *   （否则首次认领会错误地返回"未表态"）。
 *
 * ⚠️ **不可重入（R7）**：Flock 的 `acquire` 不可重入，同一 key 重入会等到 `timeoutMs`
 *   （默认 5 分钟）才失败。因此 `mutate` 回调内**禁止**调用本模块任何持锁函数
 *   （`readConsentFile` / `mutateConsentFile`）——需要读就在锁内直接读文件。
 *
 * 失败语义：写失败时清理残留 tmp 后**向上抛出**，由调用方决定降级策略
 *   （判定路径应回退为"未表态"，而不是打断采集与模型请求流程）。
 *
 * @internal 导出仅为测试（TC-ST-01/02/04/07）；生产代码请用 T1.2 的对外 API。
 */
export async function mutateConsentFile(
  state: string,
  mutate: (draft: ConsentFile) => void,
): Promise<ConsentFile> {
  const file = consentFile(state)
  return Flock.withLock(consentLock(file), async () => {
    const current = await Bun.file(file)
      .json()
      .then((data) => normalizeConsentFile(data))
      .catch(() => emptyConsentFile())
    mutate(current) // mutate 内部必须自检当前状态：并发下另一进程可能已改过
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      // 用 fs.writeFile 而**不是** Bun.write：后者会静默忽略 `mode` 选项
      // （实测 Bun 1.3.14 下 `Bun.write(p, d, { mode: 0o600 })` 得到 0o644）。
      // 本文件保存账号指纹与同意决定，权限须为 0600（同 token.enc / auth.json）。
      // tmp+rename 模式的附带好处：每次写入都是**新建文件**，因此 mode 必然生效，
      // 不存在"文件已存在导致 mode 被忽略"的陈旧权限问题。
      await fs.writeFile(tmp, JSON.stringify(current, null, 2), { mode: 0o600 })
      await fs.rename(tmp, file) // 同文件系统内为原子替换
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
    return current
  }, { dir: consentLockDir(state) })
}

/**
 * 结构归一 + schemaVersion 迁移锚点。
 *
 * 当前只存在 v1。读到**未知版本**（例如未来更高版本的文件被旧版程序读到）时
 * **按空结构处理**：对同意语义而言，宁可回到"未表态"（下次登录再问一次），
 * 也不要把无法理解的结构当成 v1 解读——后者的失败方向可能把"未同意"读成"已同意"。
 * 代价：旧版程序随后写入会把文件重写为 v1（丢弃未知字段），即"降级运行后再升级
 * 会重新询问"。方向安全；v2 真正出现时应在此实现迁移。
 *
 * 逐条校验账号记录：结构不符的条目**丢弃**（等价于该账号未表态），
 * 避免把损坏/篡改的数据读成"已同意"。
 */
function normalizeConsentFile(data: unknown): ConsentFile {
  if (typeof data !== "object" || data === null) return emptyConsentFile()
  const record = data as Record<string, unknown>
  if (record.schemaVersion !== 1) return emptyConsentFile()
  return {
    schemaVersion: 1,
    accounts: normalizeAccounts(record.accounts),
    ...(typeof record.legacyClaimed === "boolean" ? { legacyClaimed: record.legacyClaimed } : {}),
  }
}

function normalizeAccounts(value: unknown): ConsentFile["accounts"] {
  if (typeof value !== "object" || value === null) return {}
  // 过滤已用类型守卫校验，此处的断言是安全的
  return Object.fromEntries(Object.entries(value).filter((entry) => isAccountRecord(entry[1]))) as ConsentFile["accounts"]
}

function isAccountRecord(value: unknown): value is { granted: boolean; at: number } {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.granted === "boolean" && typeof record.at === "number"
}

// ── 判定与缓存（T1.2）＋ 惰性认领（T1.3）────────────────────────────────────
//
// 对外 API 全景（设计 §4.1）：
//   有 userId 的调用方（TUI 界面层）      resolveImprovementConsent / setImprovementConsent
//   没有 userId 的调用方（magpie/请求头） getCurrentImprovementConsent / setCurrentImprovementConsent / isImprovementConsentGranted
//   缓存控制（RPC 联动失效，T2.4）        invalidateImprovementConsentCache
// 所有函数带可选 state?（默认 Global.Path.state）：Global.Path 在模块加载时求值，
//   同进程无法重定向，测试靠该参数注入临时目录（设计 §4.1 的可测试性 seam）。

/** 判定结果三态：明示同意 / 明示拒绝 / 未表态（含未登录——无法识别账号即无从判定） */
export type Consent = "granted" | "declined" | undefined

/** 缓存 TTL（ADR-5）：跨进程无 RPC 时的最坏滞后兜底，对齐 access.ts 的 30s 模式 */
const TTL_MS = 30_000
/**
 * 单槽缓存（先例：access.ts 的 checked）。键必须同时包含 state 与 userId：
 *   不同状态目录的记录互不相干，缺 state 会互相命中（S2）；缺 userId 则账号互踩（D1）。
 */
let cache: { key: string; value: Consent; expires: number } | undefined

/**
 * 账号级 Improvement 同意判定（对外主入口）。
 *
 * 路径：缓存命中 → 读快照 →（该账号无记录且未认领时）惰性认领 → 读快照记录。
 * 认领可能写入并改变结论，**必须采用认领返回的最终结果**——不能复用读到的旧快照，
 *   否则首次认领会错误地返回"未表态"（B1 修正）。
 * 认领写入失败降级为"未表态"而非上抛（I-3）：本函数位于 magpie 资格判定与
 *   auth-plugin 请求头路径上，抛错会打断采集与模型请求流程。
 */
export async function resolveImprovementConsent(userId: string, state = Global.Path.state): Promise<Consent> {
  // 空串 = 无账号归属（与 parseJwtUserId 的口径一致），不查询也不认领，
  // 避免为 fingerprint("") 落一条无主记录（ST-3：不得存在自动写入默认值的路径）
  if (userId.length === 0) return undefined
  const cacheKey = `${state}\u0000${userId}`
  if (cache?.key === cacheKey && cache.expires > Date.now()) return cache.value

  const snapshot = await readConsentFile(state)
  const claimed = await claimLegacyIfNeeded(state, snapshot, userId).catch((error) => {
    logWarn("improvement consent claim failed; treating as undecided", {
      service: "deveco",
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  })
  if (claimed !== undefined) {
    cache = { key: cacheKey, value: claimed, expires: Date.now() + TTL_MS }
    return claimed
  }
  // 普通路径：从步骤 1 的快照读取（认领未触发或已被抢先时走这里；
  //   被抢先的场景下本账号仍无记录 → undefined，正确）
  const record = snapshot.accounts[accountFingerprint(userId)]
  const value: Consent = record ? (record.granted ? "granted" : "declined") : undefined
  cache = { key: cacheKey, value, expires: Date.now() + TTL_MS }
  return value
}

/**
 * 账号级写入（面板/弹窗/隐私行确认路径）。
 *
 * 返回 false 表示**未写入**（userId 无效或写失败），调用方据此回滚 UI 乐观更新
 *   （I-4 契约）。同意与拒绝均落盘（FR-4），显式操作无条件覆盖该账号的既有记录。
 */
export async function setImprovementConsent(userId: string, granted: boolean, state = Global.Path.state): Promise<boolean> {
  if (userId.length === 0) return false
  try {
    await mutateConsentFile(state, (draft) => {
      draft.accounts[accountFingerprint(userId)] = { granted, at: Date.now() }
    })
    // 成功后失效本进程缓存：下一次判定立即读到新值，不等 TTL（I-14 / FR-8）
    invalidateImprovementConsentCache()
    return true
  } catch (error) {
    // 写失败不上抛：UI 路径拿到 false 回滚即可，不应因隐私写入失败打断界面流程
    logWarn("improvement consent write failed", {
      service: "deveco",
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * 当前账号的判定（内部从 token.enc 解析 userId，ADR-3）。
 * 未登录或凭据损坏 → undefined（无从识别账号，等价于"未表态"，绝不默认同意）。
 */
export async function getCurrentImprovementConsent(state = Global.Path.state): Promise<Consent> {
  const userId = await loadUserIdFromDisk()
  if (!userId) return undefined
  return resolveImprovementConsent(userId, state)
}

/**
 * 当前账号写入。userId 不可解析 → 返回 false 且不写入（I-4 契约）：
 *   可写判据是 loadUserIdFromDisk() 能解析出 userId——仅 auth.json 有 oauth
 *   条目不足（token-storage 在解析失败时会主动删除 token.enc，两套判据会发散，
 *   见设计 §6.5 边界 1）。面板/弹窗/隐私行三处必须用同一判据。
 */
export async function setCurrentImprovementConsent(granted: boolean, state = Global.Path.state): Promise<boolean> {
  const userId = await loadUserIdFromDisk()
  if (!userId) return false
  return setImprovementConsent(userId, granted, state)
}

/** magpie 资格判定 / 请求头取值共用：未登录或未同意均为 false（FR-6 前两条件） */
export async function isImprovementConsentGranted(state = Global.Path.state): Promise<boolean> {
  return (await getCurrentImprovementConsent(state)) === "granted"
}

/**
 * 失效本进程缓存（T2.4 的 worker RPC 联动入口）。
 * 只清**本进程**：跨进程时效靠 RPC 调用方各自触发 + 30s TTL 兜底（设计 §4.3）。
 */
export function invalidateImprovementConsentCache(): void {
  cache = undefined
}

/**
 * 惰性认领（D7 / 设计 §5.2）：把设备级遗留键一次性归属给当前账号。
 *
 * 触发条件：该账号无记录 且 文件未 legacyClaimed。
 * 时序：**锁外**读 kv 遗留值（privacy-kv 锁与 consent 锁不是同一把，二者本就
 *   不互斥——一致性靠 kv 写方的 tmp+rename 原子替换，设计上不依赖锁保护，S6）；
 *   **锁内**一次 mutate 原子落盘「账号记录 + legacyClaimed」（无中间态暴露）。
 * 幂等：mutate 内自检——并发下另一进程可能已认领，此时本次写入退化为 no-op。
 * 返回：本次认领结果（调用方必须采用该值，B1）；未触发 / 无遗留 / 被抢先 → undefined。
 * 副作用边界：**不改动 kv.json**（"冻结"由 legacyClaimed 标记表达，删除或改写
 *   设备键会违反 kv 的写入者家族约定，D7 / TC-CL-08）。
 *
 * ⚠️ 本函数被 resolveImprovementConsent 在**锁外**调用；其内部的
 *   mutateConsentFile 也不得再嵌套任何持锁调用（R7：Flock 不可重入）。
 */
async function claimLegacyIfNeeded(state: string, snapshot: ConsentFile, userId: string): Promise<Consent> {
  const fp = accountFingerprint(userId)
  if (snapshot.accounts[fp] || snapshot.legacyClaimed) return undefined

  const legacy = await readToolImprovementSetting(state)
  if (legacy === undefined) return undefined // C1：从未拨动过 → 不认领，走正常询问

  const after = await mutateConsentFile(state, (draft) => {
    if (draft.accounts[fp] || draft.legacyClaimed) return // 并发自检：已被他人认领则 no-op
    draft.accounts[fp] = { granted: legacy, at: Date.now() } // C2: true→同意；C3: false→拒绝
    draft.legacyClaimed = true
  })
  // 采用 mutate 返回的最终结构：真的认领成功则记录在；被抢先则本账号仍无记录 → undefined
  const record = after.accounts[fp]
  return record ? (record.granted ? "granted" : "declined") : undefined
}
