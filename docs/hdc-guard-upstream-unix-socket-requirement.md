# 上游契约需求：NetworkSandboxPolicy::Restricted 的 unix-socket 放行（C7）

> **交付对象**：`@bitfun-ai/sandbox`（macOS 侧，Josie）
> **提出方**：deveco 产品（HDC Guard 主机防绕过，FR-HOST-101 / AR-HDC-SEC1-007）
> **目标版本**：sandbox 0.4.0
> **状态**：**暂缓（2026-10-27 上游侧决策）**——防绕过全链路验收/测试统一走 network-on 自定义 profile，不依赖本需求排期；本需求降级为后续改进项（落地后默认 network-off profile 的 `hdc` 调用可经沙箱正常使用，产品移除 `trusted_exec` 的 `skipped` 分支恢复四 canary 全验证）。`skipped` 分支在落地前保留：它保障默认 profile 可用性（去掉即默认配置下所有受保护命令被阻断，r2 BLOCKED 复现），非测试过渡。
> 背景全文见 `hdc-guard-fr-host-101-gap.md` §2.4（C7）；本文自包含，可直接作为上游开发输入。

---

## 1. 背景：产品在沙箱里用 UDS 做什么

deveco 的 HDC Guard 架构（SR1/SR2 已交付）：

```
沙箱内命令（受控命令树）
  └─ PATH 上的 hdc shim（~/.cache/deveco/bin/hdc）
       └─ UDS connect → guard endpoint（$TMPDIR/deveco-hdc-<pid>-<rand>.sock）
            └─ 沙箱外 guard 服务进程：SEC2 决策 → 代为 spawn 真实 hdc
```

- guard endpoint 是**本进程族的本地 IPC**，不访问网络、不跨用户；
- 主机防绕过（host-enforcement）靠沙箱 exec/read deny 拦直连真实 hdc，正常调用全部经 shim→UDS→guard；
- 因此"沙箱内能否 connect guard UDS"直接决定 network-off 场景下产品功能是否完整。

## 2. 现状契约（0.3.0，`@bitfun-ai/sandbox/dist/types.d.ts`）

```ts
export type NetworkSandboxPolicy =
  | { type: "Restricted" }
  | { type: "Enabled" }
```

- `Restricted`：产出 Seatbelt 配置仅一条字面量放行 `(allow network-outbound (literal "/private/var/run/syslog"))`，其余 network-outbound 全被 deny 子句覆盖；
- `Enabled`：产出通配 `(allow network-outbound)`。

## 3. 问题：Restricted 下 UDS connect 被拒（已实证）

**复现**（2026-10-26 r2 macOS 验收，darwin-arm64 0.3.0 addon）：

1. 内置 profile（read-only/workspace，`network: {enabled: false}`）沙箱内，shim connect `$TMPDIR/deveco-hdc-<pid>-<rand>.sock` → `ECONNREFUSED`（Seatbelt 拒绝，表现与无监听一致）；
2. 同一 endpoint，非沙箱进程 connect 正常；network-on（`Enabled`）沙箱内 connect 正常；
3. 产品侧已把 guard endpoint 以 fs `write` 注入策略——**不生效**，unix-socket connect 走 network-outbound 规则，不走文件访问规则。

**后果**：network-off 沙箱内正常调用链路（shim→guard）不可达，guard 侧 fail-closed（`reason_code=guard_unavailable`）。产品当前以 `trusted_exec` canary 记 `skipped` 过渡（deny 防绕过核心不受影响），但 network-off 场景的正向链路验证与功能完整性依赖本需求落地。

## 4. 需求

### 4.1 契约变更

```ts
export type NetworkSandboxPolicy =
  | { type: "Restricted"; allowed_unix_sockets?: string[] }
  | { type: "Enabled" }
```

- `allowed_unix_sockets`：可选字符串数组，每项为**绝对路径**的 unix-domain socket 文件路径；
- 空数组/缺省 = 现状行为（仅 syslog 字面量），**不破坏既有调用方**；
- 路径需做与 fs entries 一致的规范化（resolve symlink、去 `..`）。

### 4.2 Seatbelt 规则生成（darwin 后端）

对每个条目产出一条字面量放行，插在现有 syslog 规则同组：

```scheme
(allow network-outbound (literal "<normalized-socket-path>"))
```

- 仅放行 **connect**，不引入通配、不放开其他 network-outbound；
- 与 `Restricted` 其余 deny 语义共存：未列出的 socket 行为不变（被拒）；
- 策略编译失败沿用现有 fail-closed（`policy_compile_failed`）。

### 4.3 明确非目标

- 不要求 TCP/UDP 任何形式的放行；
- 不要求 Windows 侧改动（win32 不承诺主机强制）；
- 不改动 `Enabled` 语义。

## 5. 验收标准（上游侧）

| # | 用例 | 预期 |
|---|---|---|
| U1 | `Restricted` 无 `allowed_unix_sockets` | 行为与 0.3.0 完全一致（回归） |
| U2 | `Restricted` + `allowed_unix_sockets: [<sock>]`，沙箱内 connect 该 socket | 成功 |
| U3 | 同 U2，connect 未列出的其他 UDS | 仍被拒 |
| U4 | 同 U2，普通 TCP connect（如 127.0.0.1:80） | 仍被拒 |
| U5 | `allowed_unix_sockets` 含不存在路径 / 相对路径 | 编译失败 fail-closed，错误可区分 |
| U6 | 空数组 | 等价 U1 |

## 6. 落地后产品侧动作（供排期参考）

1. 依赖升级至含本能力的 sandbox 版本，mac 侧重建 darwin addon（Windows 侧无法重建）；
2. `host-enforcement.ts` 注入 guard endpoint 到 `allowed_unix_sockets`（与现有 fs write 注入并列）；
3. 移除 `trusted_exec` 的 network-off `skipped` 分支，network-off 场景恢复四 canary 全验证；
4. 验收文档（`hdc-guard-host-enforcement-acceptance.md`）删除场景 A 的 guard_unavailable 边界注记。
