# FR-HOST-101 macOS 主机强制防绕过 — 落地差距清单

> 用途：与上游（@bitfun-ai/sandbox Rust kernel）及需求侧沟通的输入
> 编制：2026-10-22
> 依据：`hdc_guard_sr2.md` §3 FR-HOST-101、`macos_sandbox_sr1.md`、`macos_sandbox_sr2.md`、当前仓库实现

---

## 0. 结论摘要

> **状态更新 2026-10-24**：第 1 层（上游契约）已关闭 —— `@bitfun-ai/sandbox` 0.3.0 提供原生
> `ProcessSandboxPolicy`（DenyListed），配置/解析/映射链路已落地（`e05bda379`）。第 3 层（产品集成
> I1~I6）已实现：受保护 hdc 清单发现与注入（`packages/opencode/src/hdc/host-enforcement.ts`）、
> `shell.ts` 自动注入 `filesystem deny` + `process.deny_exec` + 守卫 UDS 最小放行、四类 canary
> （direct_read_deny / direct_exec_deny / shim_allow / trusted_exec，失败关闭 + 负缓存），
> `host_enforcement` 打点（applied/not_applicable/bypassed/failed）。测试 TC-34 见
> `docs/hdc-guard-test-guide.md`。**剩余**：第 2 层（需求侧条款，macos_sandbox SR 新增 exec-deny FR）、
> P3 macOS 实机验收（用户手测）、副本指纹识别（当前以 read-deny 阻断树内复制，保护建立前的副本
> 沿用 SR2 §1.3.4 边界）。

FR-HOST-101 要求"受控命令树内禁止直接 exec 真实 hdc 或其可执行副本，经 Guard 获准的操作仍可正常完成"。当前缺口有三层，缺一不可：

1. **沙箱契约无 exec deny 能力**（上游，治本）
2. **沙箱 SR 无对应需求条款**（需求侧，需新增）
3. **Guard 与沙箱链路未集成**（产品侧，需设计）

---

## 1. 需求条款缺口（需求侧）

### 1.1 macos_sandbox 现状

| 文档 | 能力范围 | 是否覆盖 exec deny |
|---|---|---|
| `macos_sandbox_sr1.md` v2.0 | read-only 文件系统强制（`:root=read`）、配置模型、`/sandbox` 页面 | ❌ 无 |
| `macos_sandbox_sr2.md` v2.0 | workspace/自定义 profile/full-access 强制、网络 On/Off 强制 | ❌ 无 |

两份文档的能力模型只有两类强制：
- **文件系统**：路径级 Read/Write/Deny 条目（对应 Seatbelt `file-read*`/`file-write*` 规则）
- **网络**：Restricted（全阻断）/ Enabled

**均无"禁止 exec 特定二进制路径"的需求条款**（Seatbelt `process-exec` 规则）。FR-HOST-101 需要的"真实 hdc 直接 exec 与副本 exec 成功率 = 0"，在沙箱 SR 里没有对应 FR。

### 1.2 需新增的需求条款（建议，供需求侧评审）

建议在 `macos_sandbox_sr2.md`（或独立条目）新增一条 **FR-EXEC-DENY / 主机强制能力**：

| 项 | 内容 |
|---|---|
| 陈述 | 受控命令进程树内，进程不得通过直接 exec 或等价副本 exec 指定的受保护二进制（如真实 hdc 绝对路径）；经宿主（Deveco Guard）获准的调用必须放行 |
| 能力载体 | Seatbelt `process-exec` deny 规则 + 白名单（受控入口自身） |
| 参数 | 受保护二进制清单（产品预置：DevEco SDK 的 hdc 路径；是否含复制品指纹/哈希识别待定） |
| 验收 | 控制边界内直接 exec 与副本 exec 成功次数为 0；正常受控调用成功；保护建立失败时不启动 |
| 边界 | 不覆盖沙箱外同用户进程、root/管理员、内核漏洞（沿用 CON-01） |

> 备选：此条款也可作为独立 SR（如 `deveco_host_hdc_guard.md`）而非塞进 macOS 沙箱 SR，因为它的消费方是 HDC Guard 而非通用命令沙箱。需要与需求侧确认归属。

---

## 2. 沙箱契约能力缺口（上游 @bitfun-ai/sandbox）

### 2.1 现状契约（0.2.20，`packages/opencode/node_modules/@bitfun-ai/sandbox/dist/types.d.ts`）

```ts
export type PermissionProfile =
  | { type: "Managed"; file_system: FileSystemSandboxPolicy; network: NetworkSandboxPolicy }
  | { type: "Disabled" }

export interface FileSystemSandboxPolicy {
  kind: FileSystemSandboxKind        // Restricted | Unrestricted
  glob_scan_max_depth: number | null
  entries: FileSystemSandboxEntry[]  // { path, access: Read|Write|Deny, missing_path_behavior }
}

export type NetworkSandboxPolicy =
  | { type: "Restricted" }
  | { type: "Enabled" }
```

- `PermissionProfile` 只有 `file_system` + `network` 两个维度
- `FileSystemAccessMode` 只有 `Read`/`Write`/`Deny`，对应文件数据访问，**不是 exec**
- `SandboxErrorCode` 无 exec-deny 相关错误

### 2.2 契约变更点（向上游提的能力清单）

| # | 变更点 | 说明 |
|---|---|---|
| C1 | `PermissionProfile` 增加 `process` 维度 | `process: ProcessSandboxPolicy`（独立于 file_system/network，可空） |
| C2 | 新增 `ProcessSandboxPolicy` | 含 `exec_deny: ExecDenyRule[]`、`exec_allow: string[]`（白名单） |
| C3 | 新增 `ExecDenyRule` 表达 | 支持三种形态：绝对路径精确匹配、目录前缀（防复制副本落在相邻目录）、可选 sha256 指纹（防改名/重编译副本） |
| C4 | Seatbelt 后端产出 `(deny process-exec* ...)` 规则 | 白名单在 deny 之前生效；`sandbox-exec` 自身与目标 shell 入口放行 |
| C5 | 新增稳定错误类型 | `ExecDenyUnsupported` / `ProcessPolicyFailed`（沿用 fail closed：策略编译失败即不启动） |
| C6 | `prepare()` 返回值可带执行结果标记 | 供宿主判断"是否实际应用了 exec deny"，用于打点 `enforcement_result` |
| C7 | `NetworkSandboxPolicy` `Restricted` 增加 `allowed_unix_sockets: string[]` 字面量 | 见 §2.4；host-enforcement allow-path 在 network-off 沙箱内的最后一处契约缺口 |

### 2.4 C7：guard UDS 的 unix-socket 放行缺口（2026-10-26 验收发现）

**现象**（r2 macOS 验收）：内置 profile（read-only/workspace，`network: {enabled: false}`）下，沙箱内 shim 连接 guard UDS 被拒（`ECONNREFUSED` → `reason_code=guard_unavailable`），trusted_exec canary fail-closed 导致全部受保护命令被阻断。

**根因证据**（darwin native addon `sandbox.node` 提取的 Seatbelt 模板）：

- `NetworkSandboxPolicy::Restricted` 下无通配 `(allow network-outbound)`，仅 `(allow network-outbound (literal "/private/var/run/syslog"))` 字面量——unix-socket connect 需 network-outbound 规则，guard UDS（`$TMPDIR/deveco-hdc-<pid>-<rand>.sock`）不在放行之列
- `NetworkSandboxPolicy::Enabled` 才有 `(allow network-outbound)` 通配，故 network-on 场景 allow-path 完整可用
- 当前契约（0.3.0 `types.d.ts`）`NetworkSandboxPolicy` 仅 `Restricted | Enabled`，**无 unix-socket 字面量表达能力**；fs write 注入 guard endpoint 不覆盖 connect

**产品侧 interim 处理**（已实现，`host-enforcement.ts`）：armed 且 network-off 时 `trusted_exec` canary 记 `skipped`（不 fail-closed，deny canaries 仍全部强制）；沙箱内 `hdc` 调用保持 fail-closed（`guard_unavailable`，无旁路）。完整 allow-path 验证走 network-on 场景（验收文档场景 B）。

**向上游诉求**：`NetworkSandboxPolicy::Restricted` 支持按路径放行 unix-socket connect（类比 syslog 字面量），用于本地 IPC（guard UDS），0.4.0 目标。落地后产品移除 `skipped` 分支，network-off 场景恢复 trusted_exec 全验证。完整独立需求文档（含验收标准）见 `hdc-guard-upstream-unix-socket-requirement.md`。

> **状态更新 2026-10-27（上游侧决策）**：C7 **暂缓**。防绕过全链路（含 allow-path）的验收/测试统一走 network-on 自定义 profile（验收文档场景 B），不依赖上游排期；产品侧 `trusted_exec` 的 network-off `skipped` 分支**保留**（它保障的是默认 profile 可用性，非测试过渡，去掉即复现 r2 BLOCKED）。C7 降级为后续改进项：落地后默认 profile（network off）的 `hdc` 调用可经沙箱正常使用，并恢复四 canary 全验证。

### 2.3 平台能力确认

- Seatbelt 原生支持 `(deny process-exec* (literal "path"))`——**macOS 侧能力存在**，缺的是 Rust 后端的契约暴露与规则生成
- Windows 不承诺主机强制（`hdc_guard_sr2.md` §1.3.1），契约变更可不影响 win32
- 当前 vendor 包 `sandbox-darwin-arm64` 为 0.2.19（用户侧），仓库依赖 0.2.20；均无 exec deny

---

## 3. 产品侧集成缺口（Deveco / HDC Guard）

### 3.1 现状链路

```
bash 工具（受控命令树）
  └─ shell.ts isMac 分支：resolveSandboxProfile → toNativePrepareRequest → prepare() → sandbox-exec spawn
      策略 = file_system(read/workspace 路径条目) + network(Restricted/Enabled)
      —— 无 hdc exec deny 注入

HDC 调用（无论哪条受控路径）
  └─ PATH 内 hdc shim → HdcShim.runHdcShim → UDS/NamedPipe IPC → HdcIpcServer
       └─ service.ts 决策（SEC2 判断域）→ HdcExecutor.execHdc → spawn 真实 hdc（绝对路径，clean env）
       —— 真实 hdc 由 guard 服务进程 spawn，在 sandbox 之外
```

### 3.2 集成点（产品侧需做的设计）

| # | 集成点 | 现状 | 需做 |
|---|---|---|---|
| I1 | 沙箱策略注入 hdc 路径 | `shell.ts` `toNativePrepareRequest(profile, ...)` 只传文件/网络策略 | 从 `HdcExecutor`/`service.ts` 读取真实 hdc 绝对路径，注入 `process.exec_deny` 白名单/deny 清单 |
| I2 | 受保护二进制发现 | `executor.ts:resolveHdcBinary()` 每次按 `DEVECO_HOME` + `hdcPath()` 定位 | 产品侧维护"当前会话受保护 hdc 清单"（绝对路径 + 可选指纹），供策略编译 |
| I3 | 白名单：Guard 获准后仍可执行 | 真实 hdc 由 guard 进程（sandbox 外）spawn | 保持 guard 进程在沙箱外，受控命令树内禁 exec；或白名单 guard 专用入口 |
| I4 | 失败关闭衔接 | `prepare()` 失败 → `policy_compile_failed`，命令不启动 | 扩展至 exec deny 规则编译失败同样 fail closed（FR-HOST-101 异常行为） |
| I5 | 打点 | `sandbox_request_finished` 有 `enforcement_result` | 增加主机强制状态字段（如 `host_enforcement: applied/denied/failed`）；直接 exec 旁路按 FR-OBS-101 由沙箱打点承担 |
| I6 | 副本识别 | 无 | 需要裁决：目录级 deny（hdc 所在 SDK 目录禁 exec）是保守方案；指纹匹配是精确方案。SR2 §1.3.4 明确"建立保护后外部并发替换检测"范围外，故指纹只需覆盖受控命令树内的复制行为 |

### 3.3 关键设计决策点（需产品/架构确认）

1. **执行模型**：真实 hdc 继续由 guard 服务进程（sandbox 外）spawn（现状，推荐）——受控命令树内任何 exec hdc 都被沙箱 deny，正常调用走 shim→IPC→guard 代执行，天然满足"放行经 Guard、拦截旁路"。
2. **deny 粒度**：目录级（DevEco SDK toolchains 目录禁 exec）vs 单文件（hdc 绝对路径）vs 指纹（sha256）。目录级最稳但可能误伤同目录其他工具（如 hdc_std）；建议单文件精确 + 可选指纹。
3. **属性归属**：FR-HOST-101 能力条款放沙箱 SR2 还是独立 SR，与需求侧对齐。
4. **Windows 边界**：不实现主机强制，仅用户说明披露（已满足 §1.3.1 承诺）。

---

## 4. 落地路径建议

| 阶段 | 动作 | 责任 |
|---|---|---|
| P0（当前） | 依据本清单向 @bitfun-ai/sandbox 提契约变更（C1~C6） | 产品 × 上游 |
| P0 | 向需求侧提出新增 exec-deny 条款（§1.2） | 需求 |
| P1 | 上游发布含 exec deny 的契约后，本地验证 seatbelt 规则产出 | 上游 → 产品 |
| P2 | 产品侧实现 I1~I6：策略注入、白名单、失败关闭、打点 | 产品 |
| P3 | macOS 真机/模拟器验收：直接 exec 0 成功率 + 正常调用成功 + 副本 exec 0 成功率 | 测试 |

> 依赖上游发布节奏；在契约可用前，产品侧可在 `hdc_guard_sr2.md` 验收报告中如实披露"主机强制未交付 + Windows 平台边界"，满足 §5.1 部分门槛。

---

## 5. 附：现状代码锚点

| 锚点 | 文件 |
|---|---|
| macOS 沙箱强制入口 | `packages/opencode/src/tool/shell.ts:806`（`isMac && profile && profile.profile_id !== "full-access"` → prepare） |
| 沙箱策略构造 | `packages/opencode/src/tool/shell.ts:807`（`toNativePrepareRequest`） |
| 真实 hdc 定位 | `packages/opencode/src/hdc/executor.ts:27`（`resolveHdcBinary`） |
| 真实 hdc spawn | `packages/opencode/src/hdc/executor.ts`（`execHdc`，clean env + 去 shim PATH） |
| guard 决策链路 | `packages/opencode/src/hdc/service.ts:285`（`HdcExecutor.execHdc`） |
| 沙箱公共契约类型 | `packages/opencode/node_modules/@bitfun-ai/sandbox/dist/types.d.ts`（0.2.20） |
| 沙箱 runtime 服务 | `packages/core/src/sandbox.ts:617`（`SandboxRuntimeService`，lazy-init） |
