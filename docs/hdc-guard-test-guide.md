# HDC 守卫功能测试指南（SR1 + SR2 + AR-SEC1/SEC2 联合）

> 适用对象：测试同事（需求沟通 + 测试方法）
> 文档版本：2026-11-04（合并 2026-11-04 系统性审计修复用例：stdin 透传封堵 TC-41、hilog 破坏性 flag TC-42、bugreport 输出边界 TC-40）
> **权威需求文档**：`D:\Code\文档\hdc_guard_sr1.md`（DEVECO-SR-HDC-01 v3.0，基础策略网关）
> 　＋ `D:\Code\文档\hdc_guard_sr2.md`（DEVECO-SR-HDC-02，高级操作/持久允许/复杂调用）
> 　＋ `D:\Code\文档\hdc_guard_sec1_ars.md` / `hdc_guard_sec2_ars.md`（架构分配 AR：SEC1 接入与执行、SEC2 判断域）
> **需求侧 SEC2 验证文档**：`hdc_guard_sec_sr2.md`（同事提供）——其用例与 Permission 配置说明已合并进本文（对照表见附录 C）
> **构建版本**：`feat-OBP/261017` 分支 r3 构建（`*-host-r3` 包，向开发团队获取；macOS 主机防绕过验收 2026-10-27 通过）；最新修复验证包 `0.0.0-feat-OBP/261017-202611040341`（含 stdin 透传封堵、hilog 破坏性 flag 审批，见 TC-41/TC-42）
> **自动化基线**：9 条 live-e2e 全绿（`packages/opencode/test/live-e2e/cases/hdc-guard-*.case.ts`）；hdc 单测 core 300 pass / opencode 64 pass（Windows 实测，unix-only 用例 14 skip）/ 0 fail（`packages/opencode/test/hdc/` + `packages/core/test/hdc/`）；host-enforcement 单测 13 pass；审批可访问性单测 4 pass（`packages/tui/test/cli/tui/permission-accessibility.test.tsx`）

> **对齐说明**：SR2 判断域（AR-SEC2-001~008）与 SEC1 接入/执行 AR 已合并落地。期望 reason code 为 SEC2 21 码（见附录 A.1；2026-10-24 TBD 冻结后新增 `param_readonly`/`param_not_allowed`）。本文档用例预期以 SR1 v3.0 + SR2 + AR 为权威依据，与当前实现行为一致。

> **验证状态总览（2026-10-27）**：SR1/SR2/AR-SEC1/AR-SEC2 **全部实现并验证**——live-e2e 9 条全绿；SR1 手动验收（Windows 模拟器门3 5/5 + macOS 全绿）完成；**macOS 主机防绕过（FR-HOST-101 / AR-HDC-SEC1-007）验收通过**（r3 双场景 + full-access 豁免 + M8 模拟器实调，报告 `hdc-guard-host-enforcement-acceptance-summary.md`）；Windows r3 E2E 通过。待办：真机 M8 补测、兼容性矩阵（NFR-COMP）另行安排、需求侧按本文执行一轮正式验收回执。证据索引见附录 D。
> **2026-11-04 系统性审计修复**：stdin 透传绕过封堵（TC-41）、hilog 破坏性 flag 恢复审批（TC-42）、bugreport 输出边界补齐（TC-40）已交付（单测全绿）；端到端验收按 `202611040341` 包执行（见附录 D.2 #7）。

---

## 1. 需求概述

### 1.1 需求背景

Deveco Code 的 Agent 通过 bash 工具（受控 shell）执行 `hdc` 命令时，命令可能直接或经 npm/Gradle/Hvigor 等**任意深度**子进程、后台任务发起设备操作。仅依赖模型判断或逐条命令确认，无法可靠覆盖设备固件变更、系统状态修改、越界文件传输、端口转发等高风险操作。

本需求在 Agent 与真实 `hdc` 之间建立 **HDC 策略网关（守卫）**：

- **SR1（v3.0）**：基础策略网关。所有受控 shell 内的 hdc 调用进入统一策略流程，按**产品冻结的固定策略表**（§2.1）判定放行（allow）、逐次审批（ask）或拒绝（deny/hard deny）；对象校验失败、环境不兼容、守卫不可用一律失败关闭（fail closed），不回退真实 hdc。
- **SR2**：在 SR1 之上加入高级操作细粒度策略（§2.1）、未分类操作兜底确认（§2.2）、系统 Permission 集成（FR-PERM-101）、`Always allow` 持久允许（FR-APPROVAL-101）、任意深度/后台复杂调用覆盖（FR-GATE-101）、统一打点规则来源 `policy_source`（FR-OBS-101）。
- **AR-SEC1/SEC2**：将系统需求分配给接入与执行（SEC1）和判断域（SEC2）。本次交付重点新增：**shim 私有 IPC 协议握手加固**（版本协商、能力协商、OS peer PID 探测，AR-SEC1-002）与**真实 hdc 二进制身份验证**（Authenticode/codesign，AR-SEC1-006）。

### 1.2 守卫职责与固定策略（SR1 §2.1 冻结表 + SR2 §2.1 高级策略）

策略由产品预置，判断顺序固定：**版本/输入校验 → 产品硬拒绝 → 已知策略+对象边界 → 未分类兜底 → 权限最终决策**（详见附录 A.3）。

**SR1 基础策略（冻结表）**：

| 类别 | 操作 | 决策 |
|---|---|---|
| 基础查询（非设备） | `version` / `help` / `list targets` / discover | **allow**（真实执行，无审批） |
| 基础查询（设备只读） | `shell getprop` / `shell param get` / ps / ls / cat / dumpsys / hilog（**不含** `-r`/`-w` 破坏性 flag；含则升 ask，见 TC-42） | **allow**（真实执行，无审批；保持真实 HDC 目标选择语义，不注入 `-t`） |
| 基础变更 | `install` / `shell aa start` / `file send` / `file recv` | **ask**（对象校验通过后逐次确认） |
| 产品硬拒绝 | mount、dd、mkfs、flash、erase、format、sideload、update（含 `shell` 包装）、系统 bundle 卸载 | **hard deny**（用户确认与配置均不可放行） |
| 未分类操作 | 不在已知策略中的 option/subcommand | 一次性 ask（SR2 §2.2 兜底，不持久 allow） |

**SR2 高级操作策略（§2.1）**：

| 操作类别 | 代表操作 | SR2 默认决策 | 策略上限 / 对象边界 |
|---|---|---|---|
| 应用生命周期 | `uninstall`（非系统 bundle）、`shell aa force-stop` / `aa stop`、`bm uninstall` | ask | 只允许已识别的非系统 bundle；最多为 ask |
| 设备文件变更 | `shell rm` / `chmod` / `chown` / `mkdir` / `rmdir` | ask | 明确允许的设备路径内最多为 ask，其他 deny |
| 参数修改 | `shell param set` | ask | 参数 allowlist 内最多为 ask，其他 deny |
| 诊断输出 | `bugreport` | ask | 输出范围校验通过时可配置为 allow，其他 deny |
| 端口转发 | `fport` / `rport` | ask | 方向、端点、端口 allowlist 内最多为 ask，其他 deny |
| 设备连接 | `tconn` | ask | endpoint allowlist 内最多为 ask，其他 deny |
| 系统状态 | `smode` / `tmode` / `daemon` / `reboot` / `boot` | deny | 当前 SR 不提供放宽，Permission 配置与 saved permission 均不可覆盖 |
| 未分类或未显式支持 | 未命中上述策略、但当前执行通道能承载的请求 | 一次性 ask | 展示完整请求 + "影响未知"提示；不持久 allow |

**可配置边界（SR2 §2.3 摘要）**：基础查询可在 allow/ask/deny 间收紧；`install`/`aa start`/`file send`/`file recv`/`bugreport` 可配置为 allow（对象边界内）；应用生命周期、设备文件变更、参数修改、端口转发、设备连接可收紧、只能放宽到 ask；系统状态与产品硬拒绝不可放宽；未分类可收紧为 deny、不可持久 allow。

### 1.3 对象边界（FR-OBJECT-001 / 002）

- **install**：hap 必须是工作区内当前项目产物、应用身份与当前项目一致、非系统应用
- **`aa start`**：bundle 与当前项目一致
- **`file send`**：源文件在工作区内、设备目标在"设备允许路径"（产品预置清单 `/data/local/tmp/`）
- **`file recv`**：本机目标在工作区内且安全创建、设备源在"设备允许路径"
- 设备允许路径是**产品预置策略清单**（非用户配置）；workspace 概念不映射到真机
- 歧义即拒绝：多设备缺 `-t` 时拒绝，不自动选第一台
- **会话 workspace 应为工程根目录**：workspace 指向工程子目录（如 `bin/`）时，install / uninstall / aa start / aa force-stop 的正向链路一律 `bundle_not_allowed` fail-closed（工程身份仅从工程根解析，FR-OBJECT「歧义即拒绝」）。验收正向用例请在**工程根**打开会话

### 1.4 审批与持久允许（FR-APPROVAL-001 + FR-APPROVAL-101）

- ask 类操作弹出审批界面（展示操作类型/目标对象/目标设备/风险级别）
- **Allow once**：只对当前请求有效，不创建 saved permission（SR1 语义）
- **Always allow**（FR-APPROVAL-101，SR2）：仅当产品策略上限允许 `allow` 的操作提供（`install`/`aa start`/`file send`/`file recv`/`bugreport`）。选择后**展示将要保存的匹配范围**并创建系统 saved permission；当前请求及后续匹配请求由该 saved permission 允许
  - 策略上限为 ask/deny/hard deny 的操作**不显示** Always allow（uninstall、force-stop、rm、param set、tconn、fport、smode、reboot、硬拒绝、未分类等）
- 审批超时 30 秒自动拒绝（`approval_timeout`）；拒绝/关闭弹窗 = `approval_denied`
- saved permission 可通过系统现有 permission 管理入口查看和删除

### 1.5 失败关闭（FR-FAIL-001 / NFR-SECU-001 / AR-SEC1-002）

任一配置加载、策略编译、守卫不可用、对象校验失败、环境不兼容、token/会话伪造、**握手失败**、**真实 hdc 身份验证失败**等步骤失败时，**拒绝启动受控命令**，真实 hdc 启动次数为 0；不存在任何降级/绕过路径。

**IPC 握手加固（AR-SEC1-002，本次新增）**：shim → IPC server 的请求帧必须通过三层校验，任一失败即拒绝且不回退真实 hdc：

| 层 | 校验 | 失败 reason_code |
|---|---|---|
| 1 版本协商 | 请求帧 `v` 必须等于 `PROTOCOL_VERSION`（v3） | `protocol_incompatible` |
| 2 能力协商 | 请求帧 `caps` 必须全部在 `PROTOCOL_CAPS`（`["stdin","stream"]`）内 | `capability_unsupported` |
| 3 OS peer PID 探测 | 请求帧 `pid` 必须存在且可探测（`process.kill(pid, 0)` 成功；幽灵/非法 PID 拒绝） | `protocol_incompatible` |

### 1.6 真实 hdc 发现与身份验证（AR-SEC1-006）

守卫按 `DEVECO_HOME` 定位真实 hdc，并验证：

- 版本下限 ≥ `3.2.0c`（版本下限而非冻结清单；不满足 → 发现失败）
- **Windows**：二进制必须带 Authenticode 签名，签名者 CN = `Huawei Technologies Co., Ltd.`（`Get-AuthenticodeSignature` 校验，pwsh 优先、powershell 5.1 回退）
- **macOS**：二进制必须有 codesign `TeamIdentifier`（产品 Team ID 常量确认后严格匹配；当前为空常量，仅要求存在）
- 任一验证失败 → **fail closed**，不产生可信 hdc 描述符（`hdc_unavailable`），命令不执行

### 1.7 复杂调用覆盖（FR-GATE-001 / FR-GATE-101）

受控命令树内由嵌套子进程（不限制固定层级）发起的普通 hdc 调用，以及环境初始化完成后和后台发起的普通 hdc 调用，必须进入与前台直接调用相同的策略流程。npm、Gradle、Hvigor、自定义环境、alias、function、嵌套子进程或后台执行均不得使普通 hdc 调用绕过策略。

### 1.8 遥测与审计（FR-OBS-001 / FR-OBS-101）

- 每次受控命令产生 `hdc_request_started` / `hdc_request_finished` 事件，按 request_id 配对；finished 区分策略决策/审批结果/执行结果/失败阶段/错误类型/耗时
- **FR-OBS-101（SR2）**：finished 事件记录最终决策的规则来源 `policy_source`，区分产品默认（`product_default`）、Permission 配置（`permission_config`）、saved permission（`saved_permission`）和单次审批（`one_time_approval`）
- 打点与审计**不得包含**完整 argv、凭据、环境变量、用户绝对路径、文件内容、设备序列号
- 审计文件 `hdc-guard-audit.jsonl`：仅记录 allow 与审批类（ask-approved / ask-rejected / ask-timeout），非审批类拒绝不审计

### 1.9 可访问性（NFR-ACC-001）

审批界面必须支持键盘和屏幕阅读器，风险信息不只依赖颜色表达：

1. **键盘可操作**：方向键（或 h/l）切换选项、回车确认、Esc 拒绝
2. **屏幕阅读器可读**：操作类型、命令原文、目标设备、风险文案、选项全部以文本节点渲染（不是纯图形/色块）
3. **风险不只依赖颜色**：风险描述是独立文案（`permission.hdc_risk_*` i18n 键），与 △ 警告字形叠加，去掉颜色后信息仍完整；中英文 locale 均为文本表达

### 1.10 productDefault / productCeiling 与 Permission 复用（SEC2 判断域要点）

- 每个进入 Permission 的已知操作携带两个策略属性：
  - **productDefault**：该操作的默认决策（allow / ask / deny）
  - **productCeiling**：该操作允许的最宽松决策上限，**Permission 配置、saved permission、审批结果均不得突破**（`enforceCeiling()` 收紧）。例：uninstall 的 `productCeiling=ask`——即使 Permission 配置为 allow，最终仍为 ask；reboot/固件变更的 `productCeiling=deny`——配置 allow 无效，直接 deny
- **Permission 复用**：HDC 守卫**不建立专用规则存储**，直接复用系统既有 Permission——配置格式、优先级、作用域、生命周期完全遵循系统规则（配置入口与示例见附录 B）
- 最终决策由系统 Permission 评估：结合 productDefault、productCeiling、用户配置、saved permission、审批结果综合得出 allow / ask / deny
- **决策规则**：productDefault 是"无任何其他规则时的基线"，**不是下限**——优先级为 配置规则 > saved/one-time 审批 > productDefault；ceiling 只限制**放宽方向**（任何来源的效果不得超过 ceiling），收紧方向永远自由（ceiling=allow 的操作仍可配置为 ask/deny）。配置 `"*": "allow"` 时的完整结果：

| 操作类别（代表） | productDefault | productCeiling | 配置 `"*": "allow"` 的结果 |
|---|---|---|---|
| 基础查询 / 设备只读（`hdc list`/`hdc shell cat`） | allow | allow | allow（本来就是） |
| install / aa start / file send / file recv / bugreport | ask | **allow** | **allow，不弹审批**（`policySource=permission_config`） |
| 生命周期 / 设备文件修改 / param set / fport / tconn / 未分类 | ask | **ask** | **压回 ask，照常弹审批**（`enforceCeiling()`） |
| system_state / 固件变更 / 系统包卸载（`mount`/`dd`/reboot） | deny | **deny** | **无效——不进 Permission 评估，直接硬拒** |

  对应代码：`enforceCeiling()`（packages/core/src/hdc/product-policy.ts）、硬拒前置检查（packages/core/src/hdc/guard.ts）。

---

## 2. 测试范围

### 2.1 本次测试范围

| 范围 | 说明 |
|---|---|
| 固定策略执行（SR1+SR2） | allow / ask / hard-deny 矩阵、高级操作策略（uninstall/force-stop/param set/bugreport/tconn/fport/smode/reboot）、未分类兜底、系统 bundle 拒绝 |
| 对象边界 | install / file send-recv / aa start 的本机与设备侧边界校验 |
| 审批流 | 逐次审批、Allow once 不持久、Always allow 持久允许、拒绝/关闭/超时、审批界面信息完整性 |
| 失败关闭 | 守卫不可用、伪造 token/会话、hdc 未发现、版本不兼容、**握手拒绝（v/caps/pid）**、**hdc 身份验证失败** |
| 执行保真 | stdout/stderr/退出码保真、取消、并发隔离、深层级/后台子进程同策略 |
| 遥测与审计 | started/finished 配对、`policy_source` 规则来源、审计内容、脱敏 |
| 可访问性 | 审批界面键盘操作、屏幕阅读器文本、风险非纯颜色表达（NFR-ACC-001） |

### 2.2 本次测试不覆盖

| 不覆盖项 | 原因 |
|---|---|
| 兼容性矩阵（NFR-COMP-001 / NFR-COMP-101） | 本轮不验证，另行安排 |
| PTY / 交互式终端 | 不支持（裸 `hdc shell` 属范围外能力，见 SR2 §2.2） |
| 校验后 TOCTOU 竞态防护 | 需求明确范围外（revalidateAfterAsk 作纵深防御保留） |

> **变更说明**：macOS 主机强制防绕过（FR-HOST-101）原列为本表"未交付"项，**已于 r3 交付并验收通过（2026-10-27）**，用例见 TC-34 与 `hdc-guard-host-enforcement-acceptance.md`。

---

## 3. 测试方法

### 3.1 测试环境

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10/11（模拟器验证主路径）；macOS Apple Silicon（UDS + unix shim + codesign 身份验证，可选） |
| 测试包 | 开发团队提供的 `deveco` 二进制包（见文首） |
| DevEco Studio | 已安装；真实 hdc 存在（`sdk\default\openharmony\toolchains\hdc.exe`），守卫在受控 shell 内自动注入 shim |
| 目标设备 | 模拟器（`127.0.0.1:5555`）或真机，`hdc list targets` 可见 |
| 测试工程 | 一个 DevEco 工程（如 `Sr1E2eApp`，bundle `com.example.sr1e2e`），至少能安装启动；工程目录内建 `hello.txt` 供 file send/recv |

**关键约定**：

- 所有用例**必须经受控入口**执行：在 deveco 会话中通过 **bash 工具**跑 hdc 命令（bash 工具 = 受控 shell，HDC 守卫入口）。**不要**在系统终端直接调真实 hdc 测守卫。
- 拒绝时受控 shell 在 stderr 输出 `[hdc-guard] reason_code=<码> message=<...>` 且退出码 1。
- 放行时行为与直接调真实 hdc 一致（stdout/stderr/退出码）；**例外：stdin 一律不透传**——设备进程 stdin 为 ignore，管道 stdin 读到 EOF 即退出（见 TC-41），所有可批准操作均为一次性命令、无交互 stdin 需求。
- 配置文件/缓存清理用后即还原。
- **ask 类用例前置检查**：确认全局与项目配置中无 `permission` 通配放行规则（尤其 `"*": "allow"`）。此类规则会使命名空间内上限为 allow 的操作（install / file send / file recv / aa start / bugreport）被 `permission_config` 直接放行、**不弹审批**，导致 ask 类用例（TC-07~TC-09、TC-17~TC-18 等）"未弹窗即成功"——日志特征为 `policySource=permission_config` 而非 `product_default`。检查点：`~/.config/deveco/deveco.json(c)`、工程内 `deveco.json(c)` / `.deveco/deveco.json`（详见附录 B.2 通配符陷阱）。

### 3.2 测试方法分类

| # | 验证方式 | 说明 | 对应用例 |
|---|---|---|---|
| 1 | 功能验证 | 放行类真实执行、拒绝类不执行、审批类批准后执行 | TC-01 ~ TC-08 |
| 2 | 对象边界验证 | 越界源/目标/未知 bundle/多设备歧义，验证审批前被拒 | TC-09 ~ TC-16 |
| 3 | 审批流验证 | Allow once 不持久、Always allow 持久允许、Deny/关闭/超时 | TC-17 ~ TC-18、TC-28 |
| 4 | 失败关闭验证 | 守卫不可用、伪造 token/会话、hdc 未发现、握手拒绝、身份验证失败 | TC-19 ~ TC-21、TC-31 ~ TC-32 |
| 5 | 遥测审计验证 | 事件配对、`policy_source` 规则来源、审计内容、脱敏 | TC-22、TC-29 |
| 6 | 执行保真验证 | 长输出字节流、取消、并发隔离、深层级/后台子进程 | TC-23 ~ TC-24、TC-33 |
| 7 | 子进程包装验证 | npm/node 一层与多层子进程同策略 | TC-25、TC-33 |
| 8 | 可访问性验证 | 键盘操作、屏幕阅读器文本、风险非纯颜色（自动 + 手动抽查） | TC-30 |
| 9 | 性能抽查 | 热态系统处理时间 P95≤150ms | TC-26（可选） |

### 3.3 日志核验速查（deveco.log）

日志路径：`~/.local/share/deveco/log/deveco.log`（Windows 同路径，`~` 为用户主目录）。需求侧用例（TC-35~39 等）以日志行取证，关键 marker：

| 日志行 / 字段 | 含义 | 出现时机 |
|---|---|---|
| `permission=hdc:install action=ask` | HDC action 级审批触发（action 命名空间见附录 B） | ask 类操作进入 Permission |
| `action=allow` / `effect=deny` | 最终决策 | 每次请求评估完成 |
| `policySource=product_default` / `permission_config` / `saved_permission` / `one_time_approval` | 最终决策的规则来源（FR-OBS-101） | finished 事件 |
| `approvalResult=not_required` / `allow_once` / `always_allow` / `timeout` | 审批结果 | finished 事件 |
| `asking id=per_` + `metadata.*` | 审批请求字段：`metadata.operationType` / `targetAppOrPath` / `targetDevice` / `risk` / `reason` / `command` / `productDefault` / `productCeiling` | ask 弹窗触发时 |
| `pattern=` | Permission resource 匹配串（脱敏后，如 `device:127.0.0.1:5555/bundle:com.example.sr1e2e`） | 规则评估时 |
| `hdc_permission_evaluated` | Permission 评估完成；用户点「拒绝」时该行 `reason=approval_denied`（L3 修复，与 CLI 返回一致） | 进入 Permission 的请求 |
| `hdc_host_enforcement ... canaries=...` | 主机防绕过 canary 结果（macOS，TC-34） | 会话内首条受保护命令 |
| `sandbox_request_finished ... host_enforcement=...` | 主机防绕过命令级打点（macOS，TC-34） | 每条沙箱受保护命令 |

> 打点核验必须锚定 `message="` 前缀——argsPreview 会回显命令原文，直接 grep 命令串会假阳性。

---

## 4. 典型用例场景

### TC-01：allow — 基础查询（非设备）

**测试目标**：验证 `version` / `list targets` 经守卫放行后真实执行（FR-GATE-001 allow 类）。

**前置条件**：已启动 deveco（受控 shell 内 guard env 已注入，检查：`echo $env:DEVECO_CODE_HDC_ENDPOINT` 或 `echo $DEVECO_CODE_HDC_ENDPOINT` 非空）；设备在线（`hdc list targets` 可见序列号）。

**测试输入**：
```
hdc version
hdc list targets
```

**预期结果**：
- `hdc version` 输出真实版本横幅（含 `Ver:`），退出码 0
- `hdc list targets` 输出已连接设备/模拟器序列号（如 `127.0.0.1:5555`）
- 无审批弹窗，无 `[hdc-guard]` 拒绝输出

---

### TC-02：allow — 设备只读查询与日志

**测试目标**：验证只读查询（getprop/param get/hilog）经守卫放行且结果保真（allow 类 + FR-EXEC-001）。

**测试输入**：
```
hdc shell getprop ro.build.version.hw
hdc shell param get const.product.name
hdc shell hilog -x -z 5 -T GuardTest
```

**预期结果**：
- 各命令输出非空真实设备数据，退出码 0，无审批
- 命令带 `-t` 时保持真实目标选择语义（守卫不注入、不修改 `-t` 参数）

---

### TC-03：deny — 产品硬拒绝（固件变更）

**测试目标**：验证固件变更类命令被硬拒且设备不受影响（hard deny，确认与配置均不可放行）。

**测试输入**（任选）：
```
hdc shell mount -o remount,rw /
hdc shell dd if=/dev/zero of=/data/local/tmp/x bs=1 count=1
hdc flash boot.img
hdc erase
hdc sideload pkg.zip
hdc update
```

**预期结果**：
- 退出码 1，stderr 输出 `reason_code=hard_denied`
- 设备无任何对应副作用（核验：受控 shell 内 `hdc shell ls /data/local/tmp/x` 输出 `No such file or directory`，`hdc shell ps -ef` 无 `dd`/`mount` 进程）

---

### TC-04：deny — 系统状态变更

**测试目标**：验证系统状态命令被硬拒（product_default=deny，不可放宽）。

**测试输入**：
```
hdc reboot
hdc reboot bootloader
hdc smode
hdc tmode
hdc daemon
```

**预期结果**：`reason_code=hard_denied`（product_default=deny 的系统状态，SR2 §2.1），退出码 1，设备不重启（核验：`hdc shell uptime` 数值未归零，且 `hdc list targets` 中设备未消失重连）。

---

### TC-05：deny — 系统 bundle 卸载 / 非系统 bundle 审批

**测试目标**：验证系统应用卸载被硬拒；非系统应用卸载走审批。

**测试输入**：
```
hdc uninstall com.android.settings
hdc shell bm uninstall -n com.android.settings
hdc uninstall com.example.sr1e2e
```

**预期结果**：
- 系统 bundle（`com.android.*` / `ohos.*` 前缀）：`reason_code=hard_denied`，退出码 1，应用未卸载（核验：`hdc shell bm dump -n com.android.settings` 仍有 bundle 信息）
- 非系统 bundle（`com.example.sr1e2e`）：触发审批（ask，operationType=uninstall）；**不提供 Always allow**（策略上限为 ask）

---

### TC-06：deny — 结构不可解析

**测试目标**：验证不可可靠分词的命令被拒绝，不猜测执行（invalid_request）。

**测试输入**：
```
hdc shell "echo pwn; reboot"
hdc -t
hdc file
hdc list
```

**预期结果**：
- 各命令 `reason_code=invalid_request`，退出码 1
- 设备无任何操作（含设备重启，核验：`hdc shell uptime` 数值未归零）

**H1 复合 shell 对照矩阵**（全部应 `invalid_request`，均不弹审批、不执行）：

| 命令 | 预期 |
|---|---|
| `hdc shell "echo pwn; reboot"` | invalid_request（H1 原复现） |
| `hdc shell "echo a && reboot"` | invalid_request |
| `hdc shell "echo a \| reboot"` | invalid_request |
| `hdc shell "echo $(reboot)"` | invalid_request |
| `hdc shell "echo \`reboot\`"` | invalid_request |
| `hdc shell "(reboot)"` | invalid_request |
| `hdc shell "echo x > /system/f"` | invalid_request |
| `hdc shell echo a ";" reboot`（分离分号） | invalid_request |
| `hdc -t`（缺操作数） | invalid_request（原为 target_device_ambiguous，L1 修正） |

**非回归**（应保持原行为）：`hdc shell reboot` → `hard_denied`（不弹窗）；`hdc shell "reboot"`（引号单词）→ `hard_denied`（不弹窗）；`hdc shell echo hello` → 正常放行。

---

### TC-07：ask — 未分类操作兜底审批

**测试目标**：验证已知策略外的未分类命令兜底走逐次 ask，且不持久 allow（FR-POLICY-102）。

**前置条件**：了解审批弹窗交互方式——执行 ask 类命令后，deveco 会话会弹出审批界面（展示操作类型/目标对象/风险级别），可选 **Allow once** / **Reject**（或关闭弹窗）。

**测试输入**：
```
hdc frobnicate foo
```

**预期结果**：
- 弹出审批界面（operationType=unclassified，ceiling=ask），展示完整请求 + "影响未知"提示
- 选 **Allow once** → 真实执行；选 **Reject** → `reason_code=approval_denied`，不执行
- **不提供 Always allow**（不可持久）；再次执行需重新审批

---

### TC-08：ask — file send 审批通过 + 设备核验

**测试目标**：验证 `file send` 对象校验通过后弹审批、批准后真实传输（对应 E2E FILE_SEND_APPROVE）。

**前置条件**：工程目录内 `hello.txt` 存在（不存在则先创建，内容任意，如 `echo hello > 工程目录\hello.txt`）；审批交互方式见 TC-07 前置。

**测试输入**：
```
hdc file send 工程目录\hello.txt /data/local/tmp/sr1-test.txt
```

**预期结果**：
1. 审批界面展示操作类型（file send）/目标文件/目标设备/风险级别
2. 选择 **Allow once** → 传输执行
3. 设备核验（`hdc shell ls /data/local/tmp/sr1-test.txt`）文件存在，内容一致（`hdc shell cat /data/local/tmp/sr1-test.txt` 输出 `hello`）

---

### TC-09：ask — file recv 审批通过

**测试目标**：验证 `file recv` 批准后回传成功。

**前置条件**：TC-08 已执行（设备端 `/data/local/tmp/sr1-test.txt` 存在）。

**测试输入**：
```
hdc file recv /data/local/tmp/sr1-test.txt 工程目录\out.txt
```

**预期结果**：批准后本地文件创建成功，内容与设备端一致（`hdc shell cat /data/local/tmp/sr1-test.txt` 与本地 `cat 工程目录\out.txt` 对比）。

---

### TC-10：对象边界 — 本机源路径越界

**测试目标**：验证源文件在工作区外时被拒（local_path_denied，审批前 fail closed）。

**测试说明**：本机源路径的判定以**当前会话工作区**为边界（不是系统盘全局）。`C:\temp\secret.txt` 在工作区外即可；该文件**不需要真实存在**——守卫先做越界判断，越界即拒绝，不会继续检查文件存在性。

**测试输入**：
```
hdc file send C:\temp\secret.txt /data/local/tmp/sr1-esc.txt
```

**预期结果**：`reason_code=local_path_denied`，退出码 1，不弹审批，文件未传输。

---

### TC-11：对象边界 — 设备目标路径越界

**测试目标**：验证设备目标不在"设备允许路径"时被拒（device_path_denied）。

**测试输入**：
```
hdc file send 工程目录\hello.txt /system/bin/hello.txt
```

**预期结果**：`reason_code=device_path_denied`，退出码 1，未写入系统区。

---

### TC-12：对象边界 — 路径等价性（`..` 规范化）

**测试目标**：验证 `..`/规范化后越界的路径等价绕过被拒（FR-OBJECT-002 路径等价）。守卫先把设备路径做 POSIX 规范化（`path.posix.normalize`），再按规范化后的结果匹配允许目录前缀；`..` 无法解析或非绝对路径一律失败关闭。

**测试输入**（注意：必须用 `..` 后**真正越界**的路径，下面两条都会规范化到允许目录之外）：
```
hdc file send 工程目录\hello.txt /data/../system/bin/x
hdc file send 工程目录\hello.txt /data/local/tmp/../../../system/bin/x
```

**预期结果**：规范化后越界（分别落到 `/system/bin/x`）→ `reason_code=device_path_denied`，退出码 1，设备无残留。对照：`/data/local/tmp/../saved.txt` 规范化后仍在 `/data/` 内，属允许路径，走正常审批流（不在此用例断言）。

---

### TC-13：对象边界 — file recv 目标越界

**测试目标**：验证本机接收目标越界工作区时被拒。

**测试说明**：本机接收目标 `C:\temp\out.txt` 在工作区外即触发拒绝，目标文件无需存在。mac 下用工作区外路径（如 `/tmp/out.txt`）。

**测试输入**：
```
hdc file recv /data/local/tmp/sr1-test.txt C:\temp\out.txt
```

**预期结果**：`reason_code=local_path_denied`（本机目标越界），本地未创建文件（核验：`Test-Path C:\temp\out.txt` 为 False）。

---

### TC-14：ask — install 审批（bundle 校验）

**测试目标**：验证工程产物 install 弹审批、批准后安装成功；伪装 .hap 被拒（对应 E2E INSTALL_LAUNCH）。

**前置条件**：
- 准备一个**当前工程的真实产物** `.hap`：在 DevEco Studio 中构建工程，取 `entry\build\default\outputs\default\entry-default-signed.hap`（或 unsigned 版本），复制到工程目录，命名为 `app.hap`
- 准备一个**伪装 .hap**：在工程目录建任意文本文件改名为 `fake.hap`（内容不是合法 hap 包）
- 记录当前工程 bundle 名（`AppScope/app.json5` 或 `build-profile.json5` 中的 `bundleName`，如 `com.example.sr1e2e`），下面输入中的 bundle 需与之一致

**测试输入**：
```
hdc install 工程目录\app.hap
hdc install 工程目录\fake.hap
```

**预期结果**：
- `app.hap`（当前项目产物、bundle 与项目一致）：弹审批（**提供 Always allow**，策略上限为 allow），批准后安装成功；拒绝则不安装
- 伪装 .hap（随机文件）：`reason_code=bundle_not_allowed`，未安装

---

### TC-15：ask — aa start 审批（bundle 校验）

**测试目标**：验证 aa start 弹审批、bundle 与项目一致才可启动；未知 bundle 被拒。

**前置条件**：当前工程 bundle 名已知（同 TC-14 前置）。若 `com.example.sr1e2e` 与当前工程 bundle 不符，替换为工程实际 bundle 名；`-a` 后的 Ability 名可查 `entry/src/main/module.json5` 的 `abilities[0].name`。

**测试输入**：
```
hdc shell aa start -b <工程bundle名> -a <工程Ability名>
hdc shell aa start -b com.not.exists -a X
```

**预期结果**：
- 一致 bundle：弹审批（**提供 Always allow**，TC-15 修复：`aa start` 归入 `install_start` 上限 allow，SR2 §2.3 / FR-APPROVAL-101；此前误归 `app_lifecycle` 上限 ask、只有 Allow once / Reject 两项），批准后启动成功；拒绝则不启动
- 选 **Always allow** → 展示将保存的匹配范围（`device:<设备>/bundle:<工程bundle>`）→ 确认后启动成功；**同一 bundle 再执行一次**：不弹窗直接启动成功（saved permission 放行，日志 `policySource=saved_permission`，审计 `action=allow`，当次无审批）
- 未知 bundle：`reason_code=bundle_not_allowed`，未启动
- 对照：`hdc shell aa force-stop <工程bundle名>` 弹窗仍只有 **Allow once / Reject**（上限 ask，不提供 Always allow）

---

### TC-16：对象边界 — 多设备歧义

**测试目标**：验证多设备在线且缺 `-t` 时拒绝，不自动选第一台（target_device_ambiguous）。

**前置条件**：需要**至少两台设备同时在线**。制造方式任选：
- 模拟器 + 真机：启动模拟器（Device Manager），再 USB 连接真机并授权调试
- 两台模拟器：Device Manager 中同时启动两个模拟器实例
- 确认方式：受控 shell 内 `hdc list targets` 应输出 ≥2 个序列号（如 `127.0.0.1:5555` 与 `127.0.0.1:5556`）

**测试输入**：
```
hdc file send 工程目录\hello.txt /data/local/tmp/sr1-test.txt
hdc file send -t 127.0.0.1:5555 工程目录\hello.txt /data/local/tmp/sr1-test.txt
```

**预期结果**：
- 不带 `-t`：`reason_code=target_device_ambiguous`，不执行
- 带 `-t <正确序列号>`：弹审批，批准后可执行

---

### TC-17：审批 — Allow once 不持久化

**测试目标**：验证 Allow once 只对当前请求有效（FR-APPROVAL-001）。

**测试步骤**：执行 `hdc file send ...` → 审批界面选 **Allow once** → 随后**重复相同命令**。

**预期结果**：第二次执行审批界面**再次弹出**，需重新批准；Allow once 不创建 saved permission，不存在"记住本次批准"的持久放行。

---

### TC-18：审批 — 拒绝 / 关闭弹窗 / 超时

**测试目标**：验证审批拒绝、关闭、超时三种拒绝路径（approval_denied / approval_timeout）。

**前置条件**：审批交互方式见 TC-07 前置。

**测试输入**：
```
hdc file send 工程目录\hello.txt /data/local/tmp/sr1-deny.txt
```

**测试步骤与预期**：
1. 选 **Reject** → `reason_code=approval_denied`，退出码 1，设备无文件
2. 直接**关闭**弹窗（点弹窗右上角 × 或按 Esc）→ 视为拒绝：`approval_denied`，不执行
3. **不点审批**静置超过 30s → `reason_code=approval_timeout`，不执行

设备核验：`hdc shell cat /data/local/tmp/sr1-deny.txt` 输出 `No such file or directory`（注意：`hdc shell cat` 缺失文件时 exit 仍为 0，判断存在性以输出文本为准）。

---

### TC-19：失败关闭 — 守卫不可用

**测试目标**：验证守卫进程不可用时命令不执行（guard_unavailable，fail closed）。

**复现方式**（守卫服务内嵌于 deveco 进程，无法独立停止，推荐用"守卫不可达"模拟）：
```
# 方式 A（推荐）：覆盖 endpoint 指向不存在的 IPC 管道，等价于守卫进程不可达
DEVECO_CODE_HDC_ENDPOINT=\\.\pipe\deveco-hdc-nonexistent DEVECO_CODE_HDC_TOKEN=x DEVECO_CODE_HDC_SESSION=x hdc shell getprop ro.build.version.hw
# mac 上 endpoint 用不存在的 unix socket：
DEVECO_CODE_HDC_ENDPOINT=/nonexistent/deveco-hdc-guard.sock DEVECO_CODE_HDC_TOKEN=x DEVECO_CODE_HDC_SESSION=x hdc shell getprop ro.build.version.hw
```

**预期结果**：`reason_code=guard_unavailable`（方式 A 报 `unable to reach hdc guard`），退出码 1，不执行设备操作，真实 hdc 启动次数为 0。

---

### TC-20：失败关闭 — 伪造 token / 未注册会话

**测试目标**：验证伪造身份不获放行（guard_unavailable unauthorized）。

**复现方式**：需在**真实受控 shell**（bash 工具，guard env 已注入）中执行；先确认注入存在：
```
# Windows（PowerShell）：检查注入的守卫环境变量非空
Write-Output $env:DEVECO_CODE_HDC_ENDPOINT $env:DEVECO_CODE_HDC_TOKEN $env:DEVECO_CODE_HDC_SESSION
# mac（zsh）：检查注入的守卫环境变量非空
echo $DEVECO_CODE_HDC_ENDPOINT $DEVECO_CODE_HDC_TOKEN $DEVECO_CODE_HDC_SESSION
```
若输出为空（如普通终端直接跑 shim），说明未注入，属 TC-19 缺 env 场景，不适用本用例。

**测试输入**（保留真实 endpoint/session，仅覆盖 token）：
```
DEVECO_CODE_HDC_TOKEN=<伪造值> hdc version
DEVECO_CODE_HDC_SESSION=<伪造值> hdc version
```

**预期结果**：`reason_code=guard_unavailable`（token 不匹配报 `unauthorized`；session 未注册报 `session is not registered with this hdc guard`），退出码 1，不执行。

---

### TC-21：失败关闭 — hdc 未发现

**测试目标**：验证真实 hdc 不可发现时 fail closed（hdc_unavailable）。

**复现方式**：hdc 发现发生在**宿主 deveco 进程内**（按 DevEco Studio 标准安装路径自动发现），**shim 侧逐命令 `DEVECO_HOME` 覆盖不参与发现**（macOS 实测确认，2026-10-29）。因此复现 `hdc_unavailable` 需让宿主进程本身无法发现 hdc，二选一：

1. **临时移走真实 hdc**（推荐，测完还原）：将 `<DevEco 安装目录>\sdk\default\openharmony\toolchains\hdc(.exe)` 临时重命名（如 `hdc.bak`），然后**重启 deveco**（发现结果随宿主进程启动缓存）再执行测试输入；
2. **在无 DevEco Studio 的环境验证**：找一台未安装 DevEco Studio 的机器运行 deveco。

需在**真实受控 shell**（guard env 已注入，检查方式见 TC-20）中执行。

**测试输入**：
```
hdc install 工程目录\app.hap
```

**预期结果**：`reason_code=hdc_unavailable`（hdc 发现失败 fail closed），审批弹窗不出现，命令不执行。

---

### TC-22：遥测与审计

**测试目标**：验证 started/finished 事件配对、审计内容与脱敏（FR-OBS-001 / NFR-OBS-001）。

**测试步骤**：
1. 依次执行 allow（`hdc version`）、hard-deny（`hdc reboot`）、ask 批准（`file send`）、ask 拒绝各一次
2. 打开审计文件，确认四类记录存在且字段齐全：
   - Windows：`%LOCALAPPDATA%\deveco\state\hdc-guard-audit.jsonl`（默认 `C:\Users\<你>\AppData\Local\deveco\state\`）
   - macOS：`~/.local/state/deveco/hdc-guard-audit.jsonl`
3. 核对审计内容（**注意**：审计文件只含 allow / ask-approved / ask-rejected / ask-timeout 四类，`hdc_request_started`/`hdc_request_finished` 是遥测事件，不在审计文件中；事件配对需通过遥测打点侧查看，字段含 `requestID`/`policyDecision`/`approvalResult`/`executionResult`/`failureStage`/`durationMs`）
4. **审计 action 语义**（L3 修复，§2.3-2）：执行一条 ask 类命令（如 `hdc shell mkdir /data/local/tmp/audit-probe`）弹窗选「总是允许」→ 执行成功；**同一命令再执行一次**（当次不弹窗，saved permission 直接放行）；核对两条记录——第 1 次（用户点了总是允许）`action=ask-approved`，第 2 次（saved 放行、无审批）`action=allow`（原为 ask-approved；决策链路以 `approvalPrompted` 字段区分）
5. **deny 落点日志**（L3 修复，§2.3-3）：再触发一次 ask 类命令，弹窗选「拒绝」；查看 `deveco.log` 中对应 `hdc_permission_evaluated` 行，`reason=approval_denied`（原为 unknown_error，与 CLI 返回一致）；同时核对审计文件该条 `action=ask-rejected`

**预期结果**：
- 审计仅出现 allow、ask-approved、ask-rejected、ask-timeout 四条记录（非审批类拒绝不审计），含 requestID/callID/op/argv/action
- 遥测事件 `hdc_request_started` 与 `hdc_request_finished` 按 requestID 一一配对；finished 可区分 allow/ask/deny/取消/超时/准备失败/设备错误
- 全程打点与审计不含凭据、完整环境变量、文件内容、用户绝对路径、设备序列号等秘密原值

---

### TC-23：执行保真与取消

**测试目标**：验证 stdout/stderr 字节流保真、取消 2 秒内完成（FR-EXEC-001）。

**测试输入**：
```
hdc shell hilog -x
```

**测试步骤与预期**：
1. 长输出执行完成 → stdout/stderr 按序、无丢失/重复/串流混淆（对比执行前后设备日志行数，或与直接调真实 hdc 的同一命令输出做 diff）
2. 长命令执行后**发起取消**（取消方式：中断正在运行的 bash 工具，如按 `Esc` 或 `Ctrl+C`；取消即 shim 断开与守卫的连接，守卫收到后杀掉已生成的 hdc 子进程）→ 取消在 2 秒内完成，退出码/输出符合预期，5 秒内无残留 `hilog` 类进程
3. 残留进程核验：受控 shell 内 `hdc shell ps -ef | grep hilog` 应无输出

---

### TC-24：并发隔离

**测试目标**：验证两个会话并发执行互不串扰（NFR-RELY-001）。

**测试步骤**：开两个 deveco 会话（两个窗口，各自工作目录可相同或不同），分别用 bash 工具执行：
- 会话 A：`hdc shell hilog -x`（长输出，allow）
- 会话 B：`hdc file send 工程目录\hello.txt /data/local/tmp/sr1-conc.txt`（ask，弹审批）

**预期结果**：
- 会话 B 的审批/结果不影响会话 A 的输出流；请求按 sessionID 隔离
- 会话 A 输出完整无截断；会话 B 批准后正常传输，设备端 `hdc shell ls /data/local/tmp/sr1-conc.txt` 存在
- 两个会话的退出码/输出互不串扰

---

### TC-25：子进程包装同策略（FR-GATE-001）

**测试目标**：验证经 npm/node 一层子进程包装的 hdc 进入同一策略流程（对应 E2E SUBPROCESS）。

**前置条件**：受控 shell 内 `node` 可用（`node -v` 有输出）。

**测试输入**（经 bash 工具）：
```
node -e "require('child_process').execSync('hdc reboot')"
node -e "require('child_process').execSync('hdc version')"
```

**预期结果**：
- 一层子进程内的 hdc 同样被守卫拦截：`hdc reboot` 子进程包装 → `reason_code=hard_denied`，设备不重启
- allow 类（`hdc version`）经子进程包装仍正常放行

---

### TC-26：性能抽查（NFR-PERF-001 / NFR-PERF-101，可选）

**测试方法**：热态（先执行若干条命令使守卫/审批链路就绪）下，从守卫收到完整请求到允许执行开始/拒绝返回的系统处理时间。测量方式：
1. 连续执行同一 deny 命令（如 `hdc reboot`）n=30 次（每次间隔 ≥1s）
2. 取遥测事件 `hdc_request_finished` 的 `durationMs` 字段（不含设备执行时间），或对每次调用计时
3. 统计 P95 / P99

**预期结果**：P95 ≤ 150ms、P99 ≤ 300ms（扣除用户等待与设备执行时间）。自动化基线：边界 deny n=30 p95=128ms / p99=141ms。

---

### TC-27：SR2 高级操作策略抽查（FR-POLICY-101）

**测试目标**：验证 SR2 §2.1 高级操作矩阵的默认决策与上限。

**测试输入**（经 bash 工具，任选设备安全的子集）：
```
hdc shell param set persist.test.foo 1
hdc bugreport
hdc tconn 127.0.0.1:5555
hdc fport ls
hdc rport ls
hdc shell rm /data/local/tmp/sr1-test.txt
hdc shell chmod 644 /data/local/tmp/sr1-test.txt
hdc shell aa force-stop com.example.sr1e2e
```

> **force-stop 位置参数（L3'，Windows 验证发现）**：真实 hdc 的 `aa force-stop` 使用**位置参数**语法（不同于 `aa start`/`aa stop` 需 `-b`）。parser 仅为 force-stop 提取位置参数 bundle：
>
> | 命令 | 预期 |
> |---|---|
> | `hdc shell aa force-stop <工程bundle>`（位置参数） | ask → 批准后执行（修复点：原误判 `bundle_not_allowed`） |
> | `hdc shell aa force-stop -b <工程bundle>`（`-b` 形式） | ask → 批准后执行（非回归） |
> | `hdc shell aa force-stop com.android.settings`（非工程 bundle） | `bundle_not_allowed`（越界仍拒） |
> | `hdc shell aa stop <工程bundle>`（位置参数） | `bundle_not_allowed`（真实 hdc `aa stop` 需 `-b`，不误提取） |

**预期结果**：
- 各命令触发对应类别的审批（ask：param set / bugreport / tconn / fport / rport / rm / chmod / force-stop），审批界面展示操作类型与风险
- 策略上限为 ask 的类别（应用生命周期、设备文件变更、参数修改、端口转发、设备连接）**不提供 Always allow**
- 拒绝后设备无对应副作用（核验：`hdc shell cat /data/local/tmp/sr1-test.txt` 仍存在）

---

### TC-28：持久允许 — Always allow 与 saved permission（FR-APPROVAL-101 / FR-PERM-101）

**测试目标**：验证 Always allow 创建 saved permission 并允许后续匹配请求；管理入口可查看删除。

**测试步骤**：
1. 执行 `hdc install 工程目录\app.hap` → 审批界面应出现 **Always allow** 选项
2. 选 **Always allow** → 界面展示将要保存的匹配范围 → 确认后安装成功
3. **重复相同命令** → 本次**不再弹审批**，由 saved permission 直接放行（遥测 `policy_source=saved_permission`，当前请求审批结果为 `always_allow`）
4. 通过系统 permission 管理入口查看该 saved permission 存在；**删除**后再次执行相同命令 → 审批界面重新弹出（恢复产品默认 ask）

**对照（负向）**：策略上限为 ask 的操作（如 `hdc uninstall com.example.sr1e2e`、TC-27 各命令）审批界面**不显示** Always allow；未分类操作（`hdc frobnicate`）同样不显示且不可持久 allow。

**预期结果**：Always allow 仅出现在上限为 allow 的操作（install / aa start / file send / file recv / bugreport）；saved permission 生效、可查看、可删除；删除后恢复逐次审批。

---

### TC-29：遥测 — policy_source 规则来源（FR-OBS-101）

**测试目标**：验证 finished 事件的 `policy_source` 字段区分规则来源。

**测试步骤**（连续执行，事后核对遥测）：
1. `hdc version`（allow 类）→ `policy_source=product_default`
2. `hdc file send ...` 选 **Allow once** → `policy_source=one_time_approval`，审批结果 `allow_once`
3. `hdc install ...` 选 **Always allow**（TC-28 已保存后再执行一次）→ `policy_source=saved_permission`，审批结果 `not_required`
4. 若配置了 permission 规则收紧/放宽 → 对应请求 `policy_source=permission_config`

**预期结果**：`hdc_request_finished` 事件按上述场景正确区分 `product_default` / `one_time_approval` / `saved_permission` / `permission_config`；打点失败不改变策略或执行结果；全程不含秘密原值。

---

### TC-30：可访问性 — 审批界面键盘与屏幕阅读器（NFR-ACC-001）

**测试目标**：验证审批界面支持键盘操作、屏幕阅读器可读、风险不只依赖颜色表达。

**自动化基线**：`packages/tui/test/cli/tui/permission-accessibility.test.tsx`（4 pass）已覆盖键盘全路径（方向键切换、回车确认 once、Esc 拒绝）、文本渲染（命令/设备/风险/选项）、各风险类别独立文案、zh locale 文本表达。

**手动抽查步骤**：
1. 触发 ask 审批（如 `hdc install 工程目录\app.hap`）
2. **键盘操作**：`←`/`→`（或 h/l）切换选项，`Enter` 确认，`Esc` 拒绝——全程不依赖鼠标
3. **信息可读**：界面以文本展示操作类型、命令原文（`$ hdc install ...`）、目标设备、风险描述、选项（Allow once / Reject）
4. **风险非纯颜色**：风险描述为独立文案（如"将应用安装包安装到设备"），叠加 △ 警告字形；去掉颜色后信息仍完整

**预期结果**：键盘全路径可完成审批与拒绝；所有风险信息有文本表达（中英文 locale 均可）；风险不只靠颜色传达。

---

### TC-31：失败关闭 — IPC 握手拒绝（AR-SEC1-002，E7-E9）

**测试目标**：验证版本不匹配、能力不支持、peer PID 非法的请求帧被拒绝且不回退真实 hdc。

**自动化基线**：`packages/opencode/test/hdc/ipc.test.ts` 已覆盖三条拒绝路径（v=2 → protocol_incompatible；未知 caps → capability_unsupported；幽灵 pid=999999999 → protocol_incompatible）。

**手动复现**（协议级，可选）：向受控通道发送手工构造的请求帧：
- `v` 与 `PROTOCOL_VERSION` 不一致（如 v=2）→ `reason_code=protocol_incompatible`
- `caps` 含协议外值（如 `["teleport"]`）→ `reason_code=capability_unsupported`
- `pid` 不存在（如 999999999）或非法 → `reason_code=protocol_incompatible`

**预期结果**：三条路径均拒绝，不执行设备操作，不 fallback 到 PATH 或真实 hdc（真实 hdc 启动次数为 0）。手动步骤详见 `docs/hdc-guard-sr1-manual-test.md` E7~E9。

---

### TC-32：失败关闭 — 真实 hdc 身份验证（AR-SEC1-006）

**测试目标**：验证篡改/伪造 hdc 二进制时发现失败、fail closed。

**自动化基线**：`packages/opencode/test/hdc/registry.test.ts`（Windows 对真实 hdc.exe 的 Authenticode CN 校验签到）。

**手动复现**（Windows）：
1. 复制真实 `hdc.exe` 到一个临时 `DEVECO_HOME` 目录结构（`sdk\default\openharmony\toolchains\hdc.exe`），并用二进制编辑/重签名破坏其 Authenticode 签名
2. 受控 shell 内覆盖 `DEVECO_HOME=<临时目录>` 执行 ask 类命令

**预期结果**：`reason_code=hdc_unavailable`（签名 CN 不是 `Huawei Technologies Co., Ltd.` → 发现失败 fail closed），审批弹窗不出现，命令不执行。正常安装的 hdc（签名有效）不受影响。

---

### TC-33：复杂调用 — 深层级子进程与后台（FR-GATE-101）

**测试目标**：验证多层子进程与后台发起的 hdc 调用进入同一策略流程，不限制固定层级。

**测试输入**（经 bash 工具）：
```
# 两层子进程：node → node → hdc
node -e "require('child_process').execSync('node -e \'require(\\\"child_process\\\").execSync(\\\"hdc version\\\")\'')"
# 后台执行
hdc version &
# 环境初始化后调用（npm script 场景，任选真实工程 script）
npx --no-install <script calling hdc version>
```

**预期结果**：
- 深层子进程内的 `hdc reboot` 同样 `hard_denied`（可替换上面输入验证），`hdc version` 正常放行
- 后台 `&` 执行不绕过守卫；策略、输出、退出码与前台一致
- npm/npx/自定义环境包装的 hdc 调用同策略

---

### TC-34：macOS 主机防绕过 — exec/read 拒绝与 canary（FR-HOST-101 / AR-HDC-SEC1-007）

> 仅 macOS 实机；需要已安装 DevEco Studio（真实 hdc 存在）。Windows 不适用（§1.3.1）。
> 可操作展开（自动化提示词 + 手工清单 + 日志速查 + 回执模板）见 `hdc-guard-host-enforcement-acceptance.md`。
>
> **前置配置（2026-10-28 起必做）**：隐式默认已临时回退 `full-access`（FR-DEF-001 临时偏差 D1，沙箱权限问题未解决）。验证本用例前必须在测试目录 `deveco.json` 中**显式配置非 full-access profile**，否则无沙箱、enforcement 不激活。两种方式任选：
>
> 方式一（内置 profile，场景 A）：
> ```json
> { "sandbox": { "profile": "workspace" } }
> ```
> （或 `"read-only"`。）
>
> 方式二（自定义 profile `extends: "workspace"`，场景 B 全链路推荐）：
> ```json
> { "sandbox": { "profile": "hdc-verify", "profiles": { "hdc-verify": { "extends": "workspace", "network": { "enabled": true } } } } }
> ```
>
> **deny list 无需手工配置**：宿主强制在运行时自动扫描 DevEco 安装路径发现真实 hdc，将 `filesystem deny` + `process.deny_exec`（deny list）+ guard UDS 写放行自动注入任何非 full-access profile——内置 profile 与自定义 `extends: "workspace"` 防绕过能力完全等价，不要在 profile 中写死 hdc 路径（随机器/DevEco 版本变化，自动发现更可靠）。
>
> 沙箱权限问题解决、隐式默认恢复 workspace 后，此配置步骤可省略。

**测试目标**：验证沙箱化命令树内直接 exec/读取真实 hdc 均被拒绝，经 Guard 的调用正常完成，canary 按场景给出预期结果（见下）。

**测试场景**（r3 起双场景，详见 `hdc-guard-host-enforcement-acceptance.md` §0）：
- **场景 A（内置 profile，network off）**：`trusted_exec` 记 `skipped`（network-off 沙箱内 guard UDS 不可达，已文档化边界）；沙箱内 `hdc` 调用 fail-closed（`guard_unavailable`，无旁路）
- **场景 B（network on，完整链路）**：自定义 profile（推荐）`{ "sandbox": { "profile": "hdc-verify", "profiles": { "hdc-verify": { "extends": "workspace", "network": { "enabled": true } } } } }`，或内置 `{ "sandbox": { "profile": "read-only", "network": { "enabled": true } } }`：四类 canary 全部 `passed`，经 shim 的 allow-path 正常
- 两种场景下 deny list（hdc deny / deny_exec）均由宿主强制运行时自动注入，无需写进 profile

**测试输入**（经 bash 工具，任一非 full-access profile：内置 read-only/workspace 或自定义 extends workspace）：
```
# 1. 直接 exec 真实 hdc（绝对路径，替换为本机实际路径）
/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc list targets
# 2. 读取真实 hdc
head -c 16 /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc
# 3. 复制后 exec（复制需要读取，应同样失败）
cp /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc /tmp/hdc-copy && /tmp/hdc-copy list targets
# 4. 经 shim 的正常调用
hdc list targets
```

**预期结果**：
- 1/2/3 全部失败（权限拒绝/Operation not permitted）；`sandbox_request_finished` 日志含 `host_enforcement=applied`，`hdc_host_enforcement` 日志中 `direct_read_deny`、`direct_exec_deny`、`shim_allow` 均 `passed`；`trusted_exec` 场景 A 为 `skipped`、场景 B 为 `passed`
- 4：场景 B 正常返回（exit 0），策略与 SR1/SR2 一致；场景 A 以 `reason_code=guard_unavailable` 失败（边界，非缺陷）
- canary 任一 `failed` 时受保护命令不启动（fail closed，输出 `[ProbeFailed] hdc host-enforcement canary...`）；`skipped` 不触发 fail closed
- 边界：full-access profile 不沙箱化、`host_enforcement=bypassed`；沙箱外同用户进程、root、保护建立前的副本不在覆盖范围（SR2 §1.3.4）；network-off 下 guard UDS 不可达见验收文档 §5

---

### TC-35：审批请求字段完整性（SEC2，需求侧 TC-19）

**测试目标**：验证审批请求携带完整操作元数据（operationType / targetAppOrPath / targetDevice / risk / reason / command / productDefault / productCeiling）。

**前置条件**：设备在线；工程目录内 `app.hap` 存在；日志路径已知（§3.3）。

**测试输入**（经 bash 工具）：
```
hdc install 工程目录\app.hap
hdc shell bm uninstall -n <工程bundle名>
hdc frobnicate --flag value
```

**预期结果**：
1. 日志 `asking id=per_` 行包含 `metadata.operationType`（install / uninstall / unclassified）、`metadata.targetAppOrPath`、`metadata.targetDevice`（设备 ID 或 `N/A`）、`metadata.risk`、`metadata.reason`、`metadata.command`（审批弹窗展示的命令原文，如 `hdc install app.hap`）、`metadata.productDefault`、`metadata.productCeiling`
2. 三条命令均出现 `action=ask` 行
3. `canAlwaysAllow` 通过 `metadata.productCeiling` 间接表达：install 为 `allow`（显示 Always allow），uninstall / unclassified 为 `ask`（不显示）

---

### TC-36：resource 脱敏 — pattern 字段不含凭据（SEC2，需求侧 TC-20）

**测试目标**：验证 Permission resource 只含匹配所需字段，不含 token / 凭据 / 完整环境 / 文件内容。

**测试输入**（经 bash 工具，触发审批后核对日志）：
```
hdc install 工程目录\app.hap
hdc shell bm uninstall -n <工程bundle名>
hdc fport tcp:8080 tcp:8080
```

**预期结果**：日志 `pattern=` 字段只含结构化匹配串（如 `device:127.0.0.1:5555/package:...app.hap`、`device:.../bundle:...`、`device:.../port:tcp:8080,tcp:8080`）；**不含** token、password、secret、key、完整环境变量、文件内容、凭据。

---

### TC-37：Permission 配置规则生效（SEC2，需求侧 TC-11）

**测试目标**：验证系统 Permission 配置对 HDC 规则生效（收紧与放宽双向）。

**前置条件**：已备份配置（附录 B）；设备在线。

**测试步骤**：
1. 配置 `"permission": { "hdc:shell": "deny" }` → 重启 deveco → `hdc shell ls /data`
2. 改为 `"hdc:shell": "allow"` → 重启 → 同命令复跑

**预期结果**：
1. 配置 deny：日志出现 `effect=deny` + `policySource=permission_config`，无 `asking id=per_` 行
2. 配置 allow：日志出现 `action=allow` + `policySource=permission_config`
3. 规则经系统既有配置入口生效，无 HDC 专用配置文件；测试后恢复配置

---

### TC-38：策略上限 productCeiling 约束（SEC2，需求侧 TC-07 / TC-18 / TC-21 合并）

**测试目标**：验证 Permission 配置不得突破 productCeiling（ask 上限与 deny 上限两类）。

**前置条件**：已备份配置；设备在线。

**测试步骤**：
1. 配置 `"permission": { "hdc:uninstall": "allow" }`（试图突破 `productCeiling=ask`）→ 重启 → `hdc uninstall <工程bundle名>`
2. 配置 `"permission": { "hdc:reboot": "allow" }`（试图突破 `productCeiling=deny`）→ 重启 → `hdc reboot`

**预期结果**：
1. uninstall：日志出现 `action=ask`（**不是 allow**）+ `policySource=permission_config`（配置命中但受上限约束）；审批界面**不显示 Always allow**
2. reboot：`reason_code=hard_denied`，设备不重启（ceiling=deny，配置无效）
3. 测试后恢复配置

---

### TC-39：非设备操作不虚构目标设备（SEC2 IF-02，需求侧 TC-22）

**测试目标**：验证 version / help / list targets 等非设备操作显式表达"不适用目标设备"。

**测试输入**（经 bash 工具）：
```
hdc version
hdc help
hdc list targets
```

**预期结果**：三条均 `action=allow`，日志 `metadata.targetDevice` / `targetDevice` 字段为 `N/A`（不虚构设备）。

---

### TC-40：bugreport 输出边界校验（2026-11-04 修复）

**测试目标**：验证 bugreport 输出路径越界工作区时直接拒绝（`local_path_denied`，审批前 fail closed）。修复前 `validateOperation` 无 bugreport 分支，输出路径零校验——越界也进 ask 且可 Always allow 持久化；现补齐 §1.2「输出范围校验通过…其他 deny」：工作区外输出直接拒绝（不弹审批）；裸 `hdc bugreport` 输出落 executor cwd（工作区根，界内）正常弹审批；界内路径走与 file recv 相同的输出校验（边界 + symlink/父目录）。

**测试输入**（经 bash 工具；mac 用 `/tmp/leak.zip` 等工作区外路径）：
```
hdc bugreport C:\temp\leak.zip
hdc bugreport
hdc bugreport .\report.zip
```

**预期结果**：

| 命令 | 预期 |
|---|---|
| `hdc bugreport <工作区外路径>` | **直接拒绝**（`reason_code=local_path_denied`），退出码 1，不弹审批 |
| 裸 `hdc bugreport` | 正常弹审批（输出落 executor cwd = 工作区根，界内），批准后生成 |
| `hdc bugreport ./report.zip`（界内路径） | 弹审批，批准后生成 |

---

### TC-41：stdin 透传封堵 — 管道命令不在设备执行（2026-11-04 系统性审计修复，必测）

**测试目标**：验证审批放行后宿主**不向设备进程透传管道 stdin**。审计发现：修复前宿主把管道 stdin 无条件透传给设备端进程，`echo <任意命令> | hdc shell sh` 中 `sh` 只弹一个「影响未知」的 ask（弹窗不显示管道内容），批准后管道里的命令会在设备上真实执行（演示：管道喂 `reboot` 会重启设备）。现 stdin 一律不透传；裸交互 `hdc shell` 本就被拒（`capability_unsupported`，无 PTY），所有可批准操作均为一次性命令、无 stdin 需求。

**202611040341 包实测结果（2026-11-05）**：核心封堵**通过**——stdin 未透传，`pwned-from-stdin` 未在设备执行；但「批准后设备端 sh 读 EOF 即退出」预期**不符**——设备端 `sh` 挂起并残留（真实 hdc 不会把宿主侧 stdin EOF 转发为设备端 stdin 关闭），残留进程经 `hdc shell kill -9`（走一次 ask 审批后执行）清理。**根因**：无 `-c` 的交互式解释器不是一次性命令，批准后必然挂起残留。

**修复（2026-11-05）**：解析期直接拒绝交互式解释器——`hdc shell sh` / `bash` / `ash` / `/bin/sh` 等无 `-c` 的解释器命令一律 `capability_unsupported`（不弹审批、不执行、无设备残留），与裸 `hdc shell` 同族；`sh -c <命令>`（一次性）仍正常解析走策略。

**测试输入**（一条命令，含管道）：
```
echo "echo pwned-from-stdin" | hdc shell sh
```

**预期结果**（2026-11-05 修复后的构建 `0.0.0-feat-OBP/261017-202611050230`）：

| 命令 | 预期 |
|---|---|
| `echo "echo pwned-from-stdin" \| hdc shell sh` | **直接拒绝**（`reason_code=capability_unsupported`），不弹审批、不执行、无设备残留 |
| `echo "echo pwned" \| hdc shell bash`（及 `ash` / `/bin/sh` 等） | 同上（无 `-c` 解释器一律拒绝） |
| `hdc shell sh -c "echo hi"`（一次性） | 走正常解析/审批（非回归） |
| `hdc shell echo hello` | 正常执行（非回归：一次性命令不受影响） |

**202611050230 包实测结果（2026-11-05 回归，全部通过）**：

| 核对项 | 结果 |
|---|---|
| `echo "echo pwned-from-stdin" \| hdc shell sh` | `capability_unsupported`，无弹窗、不执行 ✓ |
| `echo "echo pwned" \| hdc shell bash` | `capability_unsupported` ✓ |
| `hdc shell sh -c "echo hi"`（非回归） | 输出 hi ✓ |
| `hdc shell echo hello`（非回归） | 输出 hello ✓ |
| 设备残留核验 | `ps -ef` 过滤无 sh/bash 残留进程 ✓ |

上一轮缺陷（审批后设备端 sh 挂起残留）确认已由解析期拒绝彻底解决：管道 stdin 注入路径在解析期即封堵，一次性命令（`sh -c`、`echo`）不受影响。

> 202611040341 及更早包：`hdc shell sh` 会弹 ask，批准后设备端 sh 挂起残留（本节实测记录），属已知缺陷；`0.0.0-feat-OBP/261017-202611050230` 起按上表新预期，已回归通过（见上）。

---

### TC-42：hilog 破坏性 flag 恢复审批（2026-11-04 系统性审计修复，必测）

**测试目标**：验证含 `-r`（**清空设备日志缓冲**）/`-w`（设备端写日志文件）的 hilog 命令不再按只读类（device_readonly）**静默放行**——破坏性操作无任何审批提示；现含 `-r`/`-w` 的 hilog 恢复 ask 审批（顶层归 device_file_change、shell 包装落 unclassified），普通日志读取仍静默放行。

**测试输入**（经 bash 工具）：

| 命令 | 预期 |
|---|---|
| `hdc hilog -r`（清日志缓冲） | 弹审批（ask），批准后执行；**不再静默清空** |
| `hdc shell hilog -r`（shell 包装） | 弹审批（ask），批准后执行 |
| `hdc hilog -w start -f /data/local/tmp/logs` | 弹审批（ask） |
| `hdc hilog`（普通读取） | 静默放行（非回归，readonly 仍 allow） |
| `hdc hilog -v time`（带只读 flag） | 静默放行（非回归） |

---

## 附录 A：规则速查表

### A.1 SEC2 21 reason codes

| reason_code | 触发场景 |
|---|---|
| `guard_unavailable` | 守卫/受控通道不可用、伪造 token、未注册会话（fail closed） |
| `protocol_incompatible` | 协议版本不匹配、peer PID 不存在/非法（握手失败 fail closed） |
| `runtime_incompatible` | HDC 版本低于支持下限 3.2.0c |
| `capability_unsupported` | 声明协议外能力（握手失败 fail closed）；裸 `hdc shell` PTY 不支持；无 `-c` 的交互式解释器（`hdc shell sh`/`bash`/`/bin/sh` 等，非一次性命令，stdin 不透传会挂起残留，TC-41） |
| `invalid_request` | 结构不可解析：元字符/缺操作数/复合 shell，不可可靠分词 |
| `hard_denied` | 产品硬拒绝：flash/mount/dd/mkfs/erase/format/sideload/update（含 shell 包装）、系统 bundle 卸载、product_default=deny 系统状态（reboot/shutdown/poweroff/smode/tmode/daemon/boot，含 shell 包装） |
| `bundle_not_allowed` | 未知 bundle、伪装 .hap（install/aa start） |
| `param_readonly` | `param set` 命中只读前缀（`const.`/`ro.`/`ohos.boot.`），直接拒绝不询问 |
| `param_not_allowed` | `param set` 不在 allowlist（`persist.sys.hilog.`/`debug.`/`persist.ace.darkmode`/`persist.sys.font_scale`/`persist.sys.font_wght_scale`），fail closed |
| `local_path_denied` | 本机路径越界工作区（file send/recv；bugreport 输出路径越界，TC-40） |
| `device_path_denied` | 设备路径越界允许目录、`..`/规范化失败 |
| `endpoint_not_allowed` | tconn/fport 端点不在 allowlist |
| `target_device_ambiguous` | 多设备缺 `-t`（不自动选第一台） |
| `permission_invalid` | 权限系统返回非法结果（防御性） |
| `approval_denied` | 审批拒绝、关闭弹窗 |
| `approval_timeout` | 审批超时（30s） |
| `saved_permission_failed` | always 保存失败（防御性） |
| `hdc_unavailable` | 真实 hdc 发现失败（DEVECO_HOME 无效、版本过低、签名验证失败） |
| `execution_preparation_failed` | 关键链路异常兜底（fail closed） |
| `device_execution_failed` | 设备执行错误 |
| `cancelled` | 取消 |

### A.2 行为矩阵（SEC2 实现）

| 决策 | 行为 | 对应操作 |
|---|---|---|
| allow | 直接执行，无审批 | `version`/`help`/`list targets`/discover；shell 只读查询（getprop/param get/ps/ls/cat/dumpsys/hilog——hilog 不含 `-r`/`-w` 破坏性 flag，含则升 ask，TC-42） |
| ask | 弹审批，逐次确认（超时 30s） | `install`、`file send`、`file recv`、`shell aa start`、非系统 bundle `uninstall`/`aa force-stop`（含位置参数形式）、shell 可写（rm/chmod/chown/mkdir/rmdir）、`hilog` 含 `-r`/`-w`（顶层 device_file_change / shell 包装 unclassified，TC-42）、`param set`（仅 allowlist 内 5 前缀；只读前缀与非白名单直接拒绝）、`bugreport`（输出界内，TC-40）、`tconn`、`fport`/`rport`、未分类操作（frobnicate 等） |
| deny | 直接拒绝（product_default=deny，不可放宽） | 系统状态（smode/tmode/daemon/reboot/boot/shutdown/poweroff，含 `hdc shell` 包装形式） |
| hard deny | 用户确认与配置均不可放行 | 固件变更（mount/dd/mkfs/flash/erase/format/sideload/update，含 shell 包装）、系统 bundle 卸载（`com.android.*`/`ohos.*`） |

**Always allow 可用性**：仅 `install`/`aa start`/`file send`/`file recv`/`bugreport`（策略上限为 allow）显示 Always allow；其余 ask 类与全部 deny/hard deny 类不显示。

### A.3 固定判断顺序（SEC2）

输入/版本校验 → parse（不可解析 → `invalid_request`）→ 产品硬拒绝（→ `hard_denied`）→ known + 对象边界（→ `local_path_denied`/`device_path_denied`/`endpoint_not_allowed`/`bundle_not_allowed`/`target_device_ambiguous`）→ 未分类兜底（→ ask）→ 权限最终决策（allow / ask / deny）。

握手层（此前置）：版本协商（v）→ 能力协商（caps）→ PID 探测 → token 认证 → 会话校验。

### A.4 审批与审计规则

| 规则 | 内容 |
|---|---|
| 审批超时 | 30 秒，超时自动拒绝（`approval_timeout`） |
| Allow once | 只对当前请求有效，不创建 saved permission |
| Always allow | 仅上限为 allow 的操作提供；展示保存范围后创建系统 saved permission；可在 permission 管理入口查看/删除 |
| 审批界面信息 | 操作类型 / 目标对象 / 目标设备 / 风险级别（含"影响未知"提示，未分类） |
| 审计文件 | `<state>/hdc-guard-audit.jsonl`，仅 allow、ask-approved、ask-rejected、ask-timeout 四类 |
| 审计 action 语义（L3 修复） | 本次审批通过的执行记 `ask-approved`；saved permission 放行的重复执行（当次无审批）记 `allow`（决策链路 `approvalPrompted` 字段区分）；用户拒绝记 `ask-rejected` |
| deny 落点日志（L3 修复） | 用户点「拒绝」时 `hdc_permission_evaluated` 行 `reason=approval_denied`（与 CLI 返回一致，原为 unknown_error） |
| 审计字段 | requestID / callID / op / argv / action |
| 脱敏要求 | 不含完整 argv、凭据、环境变量、用户绝对路径、文件内容、设备序列号 |

### A.5 NFR 指标

| ID | 维度 | 指标 | 验收标准 |
|---|---|---|---|
| NFR-PERF-001 / NFR-PERF-101 | 性能 | 热态系统处理时间 | P95 ≤ 150ms、P99 ≤ 300ms（扣除用户等待与设备执行时间） |
| NFR-RELY-001 / NFR-RELY-101 | 可靠性 | 并发 | 多命令并发执行，输出/退出/取消互不串扰；未完成审批和 Allow once 结果不得被后续请求复用 |
| NFR-SECU-001 / NFR-SECU-101 | 安全性 | 失败关闭 | 任一环节失败时未受限真实 hdc 启动次数为 0 |
| NFR-PRIV-001 / NFR-PRIV-101 | 信息保护 | 脱敏 | 打点与审计不含完整 argv、环境变量、文件内容、用户路径、凭据；审批界面秘密值脱敏 |
| NFR-OBS-001 / NFR-OBS-101 | 可观测性 | 事件配对 | started/finished 一一配对；`policy_source` 与审批结果字段覆盖；打点失败不改变强制或执行结果 |
| NFR-ACC-001 | 可访问性 | 审批界面 | 支持键盘和屏幕阅读器；风险信息不只依赖颜色表达（Inspection + Demonstration，自动化 4 pass + 手动抽查 TC-30） |

### A.6 用例与 E2E/手动对照

| 本文档用例 | E2E case | 手动验收（docs/hdc-guard-sr1-manual-test.md） |
|---|---|---|
| TC-01 / TC-02 | hdc-guard-allow-basic | A 组 |
| TC-03 ~ TC-06 | hdc-guard-deny-operations / fault-injection | B 组 |
| TC-10 ~ TC-16 | hdc-guard-object-boundary / install-launch / file-send-approve / file-send-reject | C 组 |
| TC-08 / TC-09 / TC-17 / TC-18 | hdc-guard-file-send-approve / file-send-reject | D 组 |
| TC-19 ~ TC-21 | hdc-guard-fault-injection | E 组（E1~E6） |
| TC-31 | （ipc.test.ts 自动化） | E 组（E7~E9） |
| TC-22 / TC-29 | （遥测） | F 组 |
| TC-23 / TC-24 | hdc-guard-exec-reliability | G 组 |
| TC-25 / TC-33 | hdc-guard-subprocess | — |
| TC-26 | 性能基线 n=30 | H 组 |
| TC-27 / TC-28 | — | — |
| TC-30 | （permission-accessibility.test.tsx 自动化） | — |
| TC-32 | （registry.test.ts 自动化） | — |
| TC-34 | （macOS 主机防绕过，见 `hdc-guard-host-enforcement-acceptance.md`） | 验收汇总 2026-10-27 通过 |
| TC-35~TC-39 | （需求侧 SEC2 用例，见附录 C） | — |
| TC-40 | （guard.test.ts / validators.test.ts 自动化） | — |
| TC-41 | （service.test.ts / executor.test.ts / parser.test.ts / guard.test.ts 自动化） | — |
| TC-42 | （parser.test.ts 自动化） | — |

---

## 5. 结果回执模板

| 项 | 结果 | 实际输出摘要 |
|---|---|---|
| 安装/冒烟（受控 shell 内 `hdc version`） | ☐ 通过 ☐ 失败 | |
| TC-01/02 allow×4 | ☐ 通过 ☐ 失败 | |
| TC-03 固件变更 hard_denied | ☐ 通过 ☐ 失败 | |
| TC-04 系统状态（reboot/smode/tmode/daemon）hard_denied | ☐ 通过 ☐ 失败 | |
| TC-05 系统 bundle 卸载 hard_denied | ☐ 通过 ☐ 失败 | |
| TC-06 不可解析 invalid_request | ☐ 通过 ☐ 失败 | |
| TC-07 未分类 ask（不持久） | ☐ 通过 ☐ 失败 | |
| TC-08/09 file send/recv 审批通过 | ☐ 通过 ☐ 失败 | |
| TC-10~13 对象边界×4 | ☐ 通过 ☐ 失败 | |
| TC-14/15 install/aa start（含 Always allow 选项） | ☐ 通过 ☐ 失败 | |
| TC-16 多设备歧义 | ☐ 通过 ☐ 失败 | |
| TC-17 Allow once 不持久 | ☐ 通过 ☐ 失败 | |
| TC-18 拒绝/关闭/超时 | ☐ 通过 ☐ 失败 | |
| TC-19~21 失败关闭×3 | ☐ 通过 ☐ 失败 | |
| TC-22 遥测审计 | ☐ 通过 ☐ 失败 | |
| TC-23/24 保真/取消/并发 | ☐ 通过 ☐ 失败 | |
| TC-25 子进程包装 | ☐ 通过 ☐ 失败 | |
| TC-26 性能抽查（可选） | ☐ 通过 ☐ 失败 | |
| TC-27 SR2 高级操作策略抽查 | ☐ 通过 ☐ 失败 | |
| TC-28 Always allow 持久允许/管理入口 | ☐ 通过 ☐ 失败 | |
| TC-29 policy_source 规则来源 | ☐ 通过 ☐ 失败 | |
| TC-30 可访问性（键盘/阅读器/非纯颜色） | ☐ 通过 ☐ 失败 | |
| TC-31 握手拒绝（自动化基线通过 + 手动可选） | ☐ 通过 ☐ 失败 | |
| TC-32 hdc 身份验证 fail closed | ☐ 通过 ☐ 失败 | |
| TC-33 深层级/后台复杂调用 | ☐ 通过 ☐ 失败 | |
| TC-34 macOS 主机防绕过（双场景，仅 mac） | ☐ 通过 ☐ 失败 | |
| TC-35 审批请求字段完整性 | ☐ 通过 ☐ 失败 | |
| TC-36 resource 脱敏（pattern=） | ☐ 通过 ☐ 失败 | |
| TC-37 Permission 配置规则生效 | ☐ 通过 ☐ 失败 | |
| TC-38 productCeiling 上限约束 | ☐ 通过 ☐ 失败 | |
| TC-39 非设备操作不虚构 targetDevice | ☐ 通过 ☐ 失败 | |
| TC-40 bugreport 输出边界（越界直接拒 / 裸命令 ask） | ☐ 通过 ☐ 失败 | |
| TC-41 stdin 断供（管道命令不执行） | ☐ 通过 ☐ 失败 | 批准后是否出现 pwned-from-stdin：否/是 |
| TC-42 hilog -r 恢复 ask / 普通 hilog 静默 | ☐ 通过 ☐ 失败 | |

---

## 附录 B：Permission 配置说明（复用系统 Permission）

### B.1 配置文件位置

| 层级 | 位置 | 优先级 |
|---|---|---|
| 全局层 | `~/.config/deveco/deveco.json(c)`（用户主目录） | 低 |
| 项目层 | `./deveco.json(c)` 或 `.deveco/deveco.json`（从 cwd 向上走到 worktree 根逐层收集） | 中 |
| 运行时注入层 | `DEVECO_CONFIG` / `DEVECO_CONFIG_CONTENT` 环境变量 / `/sandbox` 页面会话内切换 | 高 |

### B.2 配置格式

HDC permission 规则挂在顶层 `permission` 键下，与 `read`/`edit`/`bash` 等通用工具规则共用同一套配置体系：

- **简单格式**：`"action名": "effect值"`（resource 默认 `*`）
- **带路径格式**：`"action名": { "resource模式": "effect值" }`（多条 resource 规则，`findLast` 匹配，后者优先）
- **effect 取值**：`allow` / `deny` / `ask`

```jsonc
{
  "permission": {
    // HDC action 级规则（冒号分隔命名空间，与 mapToPermissionAction() 一致）
    "hdc:install": "ask",
    "hdc:file:send": "ask",
    "hdc:shell": "ask",
    "hdc:uninstall": "ask",
    "hdc:fport": "ask",
    "hdc:mode": "deny",
    "hdc:firmware": "deny",

    // 带路径收紧示例：禁止特定设备的 shell rm
    "hdc:shell": {
      "device:*/cmd:rm": "deny"
    },

    // 通用工具规则（同一套体系）
    "bash": "allow"
  }
}
```

**规则说明**：
1. resource 使用结构化格式：`device:<设备>/package:<路径>`、`device:<设备>/path:<路径>`、`device:<设备>/cmd:<命令>`；通配符 `*` 匹配所有
2. productCeiling 约束：即使配置 allow，操作上限为 ask/deny 时由 `enforceCeiling()` 收紧（TC-38）
3. 配置会被迁移为 Ruleset 数组 `{ action, resource, effect }`，由 Permission 评估按 `findLast` 顺序匹配
4. **测试后务必恢复配置**（先备份再修改）
5. **通配符陷阱**：`"*": "allow"` 这类 action 通配规则会命中**所有** HDC action——install / file send / file recv / aa start / bugreport 等上限为 allow 的操作将被直接放行且不弹审批（`policySource=permission_config`）；ask 上限操作（param set / fport / tconn / 生命周期等）仍会被 `enforceCeiling()` 压回 ask，硬拒绝类（system_state 等）不受影响（完整矩阵见 §1.10）。执行 ask 类用例前必须移除或收窄该规则（见 §3.1 前置检查）。

---

## 附录 C：与需求侧 SEC2 验证文档（hdc_guard_sec_sr2.md）用例对照

| 需求侧用例 | 本文档对应 | 备注 |
|---|---|---|
| TC-01 表驱动解析 | TC-01/02 | 日志断言见 §3.3 |
| TC-02 版本校验 | TC-21 | `hdc_unavailable` 同族（发现失败 fail closed） |
| TC-03 裸 PTY | 范围外 | SR2 §2.2 不支持裸交互 shell |
| TC-04/05 本机路径/输出路径 | TC-10/13 | |
| TC-06 硬拒绝+固定顺序 | TC-03/04 | 判断顺序见 A.3 |
| TC-07 / TC-18 / TC-21 策略上限/非法配置 | TC-38 | 三条合并为 productCeiling 约束 |
| TC-08/09 策略矩阵 | TC-01/02/27 | |
| TC-10 未分类兜底 | TC-07 | 兜底 ask 不持久 |
| TC-11 配置规则生效 | TC-37 | |
| TC-12/13 Allow once/Always allow | TC-17/28 | |
| TC-14 信息不足 fail closed | TC-16 | 多设备歧义 |
| TC-15 决策契约 | TC-22/29 | |
| TC-16 应用边界 | TC-05/14/15 | |
| TC-17 越界路径/端口 | TC-11/12/27 | |
| TC-19 审批字段完整性 | TC-35 | |
| TC-20 resource 脱敏 | TC-36 | |
| TC-22 非设备不虚构 | TC-39 | IF-02 显式 N/A |
| TC-23 审批超时 | TC-18 | |

---

## 附录 D：验证状态与证据索引（2026-10-27）

### D.1 已验证项

| 范围 | 验证方式 | 结果 | 证据 |
|---|---|---|---|
| SR1 基础策略网关 | live-e2e 9 条 + 手动验收（Windows 模拟器门3 5/5、macOS 全绿、剩余项全绿） | 通过 | `packages/opencode/test/live-e2e/cases/`；`docs/hdc-guard-sr1-manual-test.md`；SR1 验收记录 |
| SR2 高级操作/持久允许/复杂调用 | live-e2e + 手动（含 Windows E2E r2/r3） | 通过 | 同上 + `hdc-guard-host-enforcement-acceptance-result*.md` |
| AR-SEC1-002 IPC 握手加固 | `ipc.test.ts`（3 条拒绝路径） | 通过 | `packages/opencode/test/hdc/ipc.test.ts` |
| AR-SEC1-006 hdc 身份验证 | `registry.test.ts`（Authenticode CN） | 通过 | `packages/opencode/test/hdc/registry.test.ts` |
| FR-HOST-101 / AR-HDC-SEC1-007 主机防绕过 | macOS r3 验收：场景 A（network-off）+ 场景 B（network-on 全链路）+ full-access 豁免 + M8 模拟器实调 | **通过（2026-10-27）** | `hdc-guard-host-enforcement-acceptance-summary.md`；`hdc-guard-host-enforcement-acceptance.md` |
| FR-DEF-001 隐式默认 workspace | 场景 A 实测（无配置环境 enforcement 默认激活） | 曾通过（2026-10-26/27）；**2026-10-28 起隐式默认临时回退 full-access（沙箱权限问题），条款记临时偏差 D1，待沙箱修复后恢复**；此期间 macOS 验证须在 deveco.json 显式配置 `"sandbox": { "profile": "workspace" }`（或 read-only） | 验收汇总 §4；`hdc-guard-host-enforcement-acceptance.md` §1/§5 |
| NFR-ACC-001 可访问性 | 自动化 4 pass + 手动抽查 | 通过 | `permission-accessibility.test.tsx`；TC-30 |
| NFR-PERF-001 | 边界 deny n=30 p95=128ms / p99=141ms | 通过（P95≤150ms） | TC-26 基线 |
| Windows r3 E2E | echo / hdc version / hdc list targets / 打点 | 通过 | r3 交付记录（`host-r3` 包） |

### D.2 待办与边界

| # | 事项 | 状态 |
|---|---|---|
| 1 | 真机 M8 补测（本轮仅模拟器 `127.0.0.1:5555`） | 接真机后按 TC-34 场景 B / M8 补测，预期同模拟器 |
| 2 | 兼容性矩阵（NFR-COMP-001/101） | 另行安排 |
| 3 | 需求侧正式验收回执 | 测试同事按本文（TC-01~39）执行一轮并回执 |
| 4 | network-off 沙箱内 guard UDS 不可达（场景 A 边界） | 已文档化；上游 C7 暂缓（2026-10-27 决策，`hdc-guard-fr-host-101-gap.md` §2.4）。**2026-11-05 macOS 验证实测命中**：workspace 沙箱下 `hdc list targets` 报 `guard_unavailable`（UDS `ECONNREFUSED`，日志 `trusted_exec:skipped`），切 full-access/network-on 后恢复——macOS 指南 §3 已补配置注意事项 |
| 5 | 命令级失败 error_message 回写打点（验收汇总 §5.1 建议） | 登记后续改进，不影响验收 |
| 6 | PTY / 交互式终端 | 范围外（不支持） |
| 7 | 2026-11-04 系统性审计修复端到端验收（stdin 透传封堵 TC-41、hilog 破坏性 flag TC-42、bugreport 输出边界 TC-40；另含 force-stop 位置参数 L3'、L3 审计/日志语义、TC-15 aa start Always allow 等此前修复的现场回归） | 单测全绿（parser/guard/validators/service/executor）；macOS 端到端按 `0.0.0-feat-OBP/261017-202611040341` 包执行：**TC-41 核心封堵通过，但「EOF 即退出」不符**（设备端 sh 挂起残留，真实 hdc 不转发宿主 stdin EOF；经 `hdc shell kill -9` ask 审批后清理）→ 2026-11-05 修复：无 `-c` 交互式解释器解析期拒绝（`capability_unsupported`，见 TC-41），修复构建 `0.0.0-feat-OBP/261017-202611050230` 已产出（macOS 指南场景 L 已更新为新预期），待回归；其余场景（E~M）回执待收 |
| 8 | TC-41 修复回归（无 `-c` 交互式解释器解析期拒绝） | macOS 按 `0.0.0-feat-OBP/261017-202611050230` 包回归（2026-11-05）：**全部通过**——`hdc shell sh`/`bash` 管道注入 `capability_unsupported` 直接拒绝、`sh -c`/`echo` 非回归正常、`ps -ef` 核验无设备残留；上一轮「审批后 sh 挂起残留」缺陷确认彻底解决（见 TC-41） |
| 9 | 202611050230 修复包 macOS 端到端回执（场景 E~M） | 2026-11-05 回执：**TC-15（J：aa start Always allow + saved 放行）、TC-22（H：L3 审计/日志语义）、TC-40（K：bugreport 输出边界）、TC-42（M：hilog 破坏性 flag）连同 TC-41（L）全部确认解决**；场景 E/F/G/I（H1/L1、L2、M1、L3'）现场回归回执仍待收 |
