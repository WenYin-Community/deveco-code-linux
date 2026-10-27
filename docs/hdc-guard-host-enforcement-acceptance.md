# macOS 主机防绕过（FR-HOST-101 / AR-HDC-SEC1-007）验收测试用例

> 适用版本：`deveco-darwin-arm64-*-host-r3`（含 `e05bda379` + `30d425df2` + `c784fa033` + trusted_exec 网络边界修复）。
> 仅 macOS 实机；Windows 不适用（`host_enforcement=bypassed`，AR-SEC1-007 §1.3.1）。
> 通用指南见 `hdc-guard-test-guide.md`（TC-34），本文是其可操作展开：自动化提示词 + 手工清单。

## 0. 验收场景总览（r3 起为双场景）

| 场景 | deveco.json | 沙箱网络 | 验证范围 | 预期 canary 结果 |
|---|---|---|---|---|
| **A：默认/内置 profile（network off）** | `{ "sandbox": { "profile": "read-only" } }`（**必须显式配置**：隐式默认现为 full-access，不配置 = 无沙箱，见 §1 前置条件） | 关闭 | deny 防绕过核心（I1/I2/I4/I6）+ 打点/缓存 + guard_unavailable 边界 | `direct_read_deny:passed, direct_exec_deny:passed, shim_allow:passed, trusted_exec:skipped` |
| **B：network-on 自定义组合（完整链路）** | 自定义 profile `extends: "workspace"` + network on：`{ "sandbox": { "profile": "hdc-verify", "profiles": { "hdc-verify": { "extends": "workspace", "network": { "enabled": true } } } } }`（或内置 `{ "sandbox": { "profile": "read-only", "network": { "enabled": true } } }`） | 开启 | 上述全部 + I3 放行链路（trusted_exec + 沙箱内经 shim 调用 guard） | 四项全部 `:passed` |

> 为什么分两场景：network-off 沙箱在 macOS 上由 Seatbelt 拒绝一切 `network-outbound`（含 unix-socket connect），沙箱内 shim 连 guard UDS 不可达——这是当前沙箱契约（`@bitfun-ai/sandbox` NetworkSandboxPolicy 无 unix-socket 放行能力）下的已文档化边界，上游支持后消除（见 §5）。场景 A 中 `trusted_exec` 记 `skipped` 而非 fail-closed，deny canaries 仍全部强制；沙箱内 `hdc` 调用以 `guard_unavailable` 失败（fail-closed，无旁路）。

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 安装包 | `deveco-darwin-arm64-*-host-r3.tar.gz`（Windows 侧 `C:\Users\15827\Downloads`） |
| DevEco Studio | 已安装，真实 hdc 位于 `/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc` |
| **沙箱 profile** | **隐式默认已临时回退 `full-access`（2026-10-28，FR-DEF-001 记临时偏差 D1）**：沙箱侧权限问题（评测环境受限导致功能失败）未解决前，无配置环境不再默认 workspace。**因此 macOS 验证 enforcement 必须显式配置 `deveco.json`**（如 `{ "sandbox": { "profile": "read-only" } }`），不配置 = full-access = 无沙箱（`host_enforcement=bypassed`）。沙箱权限问题解决后恢复隐式 workspace（FR-DEF-001），届时无配置环境重新默认激活 |
| **deny list（防绕过拒绝清单）** | **无需在 profile 中手工配置**：宿主强制在运行时自动扫描 DevEco 安装路径发现真实 hdc，并把 `filesystem deny` + `process.deny_exec`（deny list）+ guard UDS 写放行自动注入**任何非 full-access profile**——内置 `read-only`/`workspace` 与自定义 `extends: "workspace"` 的防绕过能力完全等价。不要在 profile 里写死 hdc 路径（随机器/DevEco 版本变化，自动发现更可靠）；自定义 profile 只需声明 `extends` 与 `network` |
| 日志 | `~/.local/share/deveco/log/deveco.log` |
| 首条命令延迟 | 会话内第一条受保护命令会触发 canary（约 1–3s）+ hdc server 冷启动，属预期 |

解压初始化：

```bash
mkdir -p ~/deveco-host-test && cd ~/deveco-host-test
tar xzf <包路径>/deveco-darwin-arm64-*-host-r3.tar.gz
cd deveco-darwin-arm64
chmod +x bin/deveco vendor/ripgrep/rg
xattr -dr com.apple.quarantine .
./bin/deveco --version   # 预期输出版本串
```

**创建测试项目目录（enforcement 激活的必要条件）**——deveco 必须以该目录为工作目录启动：

```bash
mkdir -p ~/deveco-host-verify && cd ~/deveco-host-verify
cat > deveco.json <<'EOF'
{ "sandbox": { "profile": "read-only" } }
EOF
# 从测试目录启动（注意是指向解压包内 bin/deveco 的路径）
~/deveco-host-test/deveco-darwin-arm64/bin/deveco
```

> 场景 B：把 `deveco.json` 换成自定义 profile（推荐）`{ "sandbox": { "profile": "hdc-verify", "profiles": { "hdc-verify": { "extends": "workspace", "network": { "enabled": true } } } } }`，或内置 `{ "sandbox": { "profile": "read-only", "network": { "enabled": true } } }` 后重启 deveco 再跑一遍完整用例。
> 也可用 `"profile": "workspace"` 验证另一内置 profile（network off，预期同场景 A）。
> deny list（hdc deny / deny_exec）由宿主强制运行时自动注入上述任一配置，无需写进 profile（见 §1 前置条件）。
> 若要验证 full-access 显式豁免（§4 末），把 profile 换成 `full-access` 或直接删除 `deveco.json` 即可 —— 2026-10-28 起隐式默认临时回退为 `full-access`（D1 偏差），无配置 = full-access = 无沙箱。

## 2. 日志核验速查

三个 marker 行（均位于 `~/.local/share/deveco/log/deveco.log`）：

```text
# 注入 + canary 结果（会话内首次受保护命令）
# 场景 A（network off）：
hdc_host_enforcement bins=1 host_enforcement=applied canaries=direct_read_deny:passed,direct_exec_deny:passed,shim_allow:passed,trusted_exec:skipped
# 场景 B（network on）：
hdc_host_enforcement bins=1 host_enforcement=applied canaries=direct_read_deny:passed,direct_exec_deny:passed,shim_allow:passed,trusted_exec:passed
# 后续命令命中缓存
hdc_host_enforcement bins=1 host_enforcement=applied canaries=cached

# 每条命令完成打点
sandbox_request_finished request_id=... enforcement_result=applied host_enforcement=applied execution_result=success duration_ms=... cleanup_result=none

# fail-closed（canary 失败时，命令不启动）
sandbox_request_finished request_id=... enforcement_result=failed host_enforcement=failed execution_result=failed duration_ms=... failure_stage=Probe error_type=ProbeFailed error_message=hdc host-enforcement canary failed (fail closed): ...

# 场景 A 边界：沙箱内 hdc 调用（guard UDS 不可达，fail-closed 无旁路）
sandbox_request_finished request_id=... enforcement_result=applied host_enforcement=applied execution_result=failed duration_ms=... error_message=[hdc-guard] reason_code=guard_unavailable ...
```

实时观察（另一终端）：

```bash
tail -f ~/.local/share/deveco/log/deveco.log | grep -E "hdc_host_enforcement|sandbox_request_finished"
```

## 3. 自动化测试（推荐）

在测试目录启动 `./bin/deveco`，将下面整段提示词一次性粘贴给模型，由其自动执行、判定并汇总。

```text
请在 macOS 上执行主机防绕过验收测试，逐步执行、如实记录，不要重试掩盖失败，最后输出汇总表。
先用这条命令确认真实 hdc 路径，若不存在则在 /Applications 下的 DevEco* 目录中查找 toolchains/hdc 并替换后续命令：
ls -l /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc

[步骤0] 前置自检（必须通过，否则中止并报告"沙箱未激活"）
0a. 确认当前工作目录存在 deveco.json 且内容含 "profile"：
cat deveco.json
若不存在，中止并提示按验收文档 §1 创建测试目录后从该目录重启 deveco。
记录 network 是否配置为 { "enabled": true }（决定本次是场景 A 还是 B，见判定列）。
0b. 运行一条命令 echo ready，然后检查日志中本次对应的 marker：
tail -n 50 ~/.local/share/deveco/log/deveco.log
找到本会话最新的 sandbox_request_finished 行：
- 若含 host_enforcement=applied（或 hdc_host_enforcement 行 canaries=...）→ 自检通过，继续步骤1
- 若含 host_enforcement=bypassed → enforcement 未激活（full-access/未配置），中止测试并报告此事实

[步骤1] 直接读取真实 hdc（预期：被拒绝）
head -c 16 <真实hdc路径>
判定：退出码非 0 且输出含 Operation not permitted（或同类权限拒绝字样）。

[步骤2] 直接 exec 真实 hdc（预期：被拒绝）
<真实hdc路径> list targets
判定：退出码非 0（通常 126），输出含 Operation not permitted / permission denied。

[步骤3] 树内复制后 exec（预期：复制阶段即被拒绝）
cp <真实hdc路径> /tmp/hdc-copy && /tmp/hdc-copy list targets
判定：cp 失败（读取被拒），/tmp/hdc-copy 不存在（用 ls 验证）。

[步骤4] 深层子进程内 exec（预期：被拒绝，无层级豁免）
sh -c '<真实hdc路径> list targets'
判定：同步骤2。

[步骤5] 经 shim 的正常调用（预期：场景 B 成功；场景 A guard_unavailable 失败）
hdc version
hdc list targets
判定（场景 B，network enabled）：均退出码 0；输出版本号；目标列表可为空。
判定（场景 A，network off）：退出码非 0，输出含 reason_code=guard_unavailable —— 这是已文档化边界（沙箱内 guard UDS 不可达），记"边界符合预期"而非失败。

[步骤6] canary 缓存生效（预期：第二次更快）
连续再执行一次 hdc version（场景 A 改用 echo ok），记录两次耗时并对比。

[步骤7] 日志核验
tail -n 400 ~/.local/share/deveco/log/deveco.log
逐条列出并核对：
- hdc_host_enforcement 行：host_enforcement=applied；本次会话最早一条的 canaries= 中 direct_read_deny、direct_exec_deny、shim_allow 均 :passed；trusted_exec 场景 A 为 :skipped、场景 B 为 :passed（顺序不限）；其后应出现 canaries=cached
- sandbox_request_finished 行：host_enforcement=applied，且 execution_result 与步骤1-6 的实际结果一一对应（步骤1-4 对应 execution_result=failed 是命令本身被拒，enforcement_result 仍为 applied）
- 若无 hdc_host_enforcement 行，明确报告"缺失"

最后输出汇总表：每步的命令、退出码、关键输出、判定（通过/失败/边界符合预期/跳过），场景类型（A/B），以及四类 canary 日志状态。
```

分用例对照（与上表步骤一一对应，供单独重跑）：

| 用例 | 覆盖 | 提示词要点 | 场景 A 预期 | 场景 B 预期 |
|---|---|---|---|---|
| TC-A1 读取拒绝 | I1/I2 | `head -c 16 <hdc路径>` 非零退出 | 拒绝 | 拒绝 |
| TC-A2 exec 拒绝 | I1/I4 | `<hdc路径> list targets` 非零退出 | 拒绝 | 拒绝 |
| TC-A3 复制阻断 | I6 | `cp` 失败且副本不存在 | 阻断 | 阻断 |
| TC-A4 深层子进程 | AR-007 | `sh -c '...'` 同样被拒 | 拒绝 | 拒绝 |
| TC-A5 shim 放行 | I3 | `hdc version` / `hdc list targets` | guard_unavailable（边界） | 成功 |
| TC-A6 缓存与打点 | I5 | 二次更快 + `canaries=cached` + `host_enforcement=applied` | 通过 | 通过 |

## 4. 手工验证清单

逐条向 deveco 发出简短指令，同时在另一终端 `tail -f` 日志（§2 命令），核对 marker 行。
前置：deveco 必须从含 `deveco.json` 的测试目录启动（§1），否则全部记 `bypassed`。下表预期以场景 B（network on）为准；场景 A 差异处单独标注。

| # | 操作（粘贴给 deveco） | 预期现象 | 日志核对 |
|---|---|---|---|
| M0 | `cat deveco.json` 确认 profile 配置在位 | 输出含 `"profile": "read-only"` | —— |
| M1 | 任意一条命令（如 `ls`） | 会话内首条命令略慢（canary + 冷启动） | `hdc_host_enforcement ... canaries=...` 中 deny 三项 passed，trusted_exec 场景 A `:skipped` / 场景 B `:passed`；若此处为 `host_enforcement=bypassed`，立即停止并补配置重启 |
| M2 | `head -c 16 /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc` | 权限拒绝，非零退出 | 对应 `sandbox_request_finished ... execution_result=failed`，`host_enforcement=applied` |
| M3 | 直接 exec 真实 hdc（绝对路径） | `Operation not permitted`，退出码 126 左右 | 同上 |
| M4 | 复制真实 hdc 到 /tmp 再 exec | cp 阶段即失败 | 同上 |
| M5 | `hdc version` | 场景 B：正常输出版本；场景 A：guard_unavailable 失败（边界） | 场景 B `execution_result=success`；场景 A `execution_result=failed` 且错误含 `reason_code=guard_unavailable`，两者 `host_enforcement=applied` |
| M6 | 再跑一条命令 | 明显变快 | `canaries=cached` |
| M7 | `hdc list targets` | 场景 B：列表输出（可为空）；场景 A：同 M5 边界 | 同 M5 |
| M8 | （可选，接有真机时）`hdc shell "echo hi"` | 场景 B：走既有 SR1/SR2 策略；场景 A：同 M5 边界 | 策略行为与 SR1 验收一致 |

full-access 旁路验证（可选，确认显式豁免路径打点正确）：

```bash
mkdir -p ~/deveco-fullaccess-test && cd ~/deveco-fullaccess-test
cat > deveco.json <<'EOF'
{ "sandbox": { "profile": "full-access" } }
EOF
~/deveco-host-test/deveco-darwin-arm64/bin/deveco
# 让它运行 head -c 16 <真实hdc路径> —— 预期成功（full-access 是显式沙箱豁免，直接读取会成功，这是设计行为）
# 日志核对：sandbox_request_finished ... host_enforcement=bypassed
```

## 5. 边界与已知限制（验收时勿误报）

- **full-access（显式豁免）**：不沙箱化，`host_enforcement=bypassed`，直接 exec 会成功 —— 设计行为（显式豁免）。
- **隐式默认临时回退 full-access（FR-DEF-001 记临时偏差 D1，2026-10-28）**：沙箱侧权限问题（未配置环境默认 workspace 导致评测/功能失败）未解决前，无任何 sandbox 声明的环境隐式默认 `full-access`，macOS 上 enforcement 不激活（`host_enforcement=bypassed`），验证 enforcement 必须显式配置非 full-access profile。FR-DEF-001 的「隐式默认 workspace」条款在此期间不可验证，待沙箱权限问题解决后恢复 workspace 默认并解除偏差（2026-10-26 曾恢复过一次 workspace 默认，2026-10-28 因沙箱权限问题临时回退）。
- **network-off 沙箱内 guard UDS 不可达（r3 起）**：内置 profile（read-only/workspace，network off）下，macOS Seatbelt 拒绝沙箱内 unix-socket connect，沙箱内 shim 连 guard UDS 得 `ECONNREFUSED`（表现为 `reason_code=guard_unavailable`）。处理：`trusted_exec` canary 记 `skipped`（deny canaries 仍全部强制，防绕过核心不受影响）；沙箱内 `hdc` 调用 fail-closed（`guard_unavailable`，无旁路）。allow-path 完整验证统一走场景 B（network on）；上游 `@bitfun-ai/sandbox` 的 unix-socket 放行能力（C7）已决策暂缓（2026-10-27），作为后续改进登记（见 `hdc-guard-fr-host-101-gap.md` §2.4）。
- **沙箱外进程**：同用户沙箱外进程、root、保护建立前已存在的副本/硬链接不在覆盖范围（SR2 §1.3.4）。
- **ruleset 强制 ask**：若项目 ruleset 将 `hdc list targets` 设为 ask，trusted_exec 探针会超时 fail-closed（受保护命令不启动）。默认 productDefault=allow 不受影响。如需验证：配置 ask 后运行任意命令，预期出现 `error_type=ProbeFailed` 且命令不执行 —— 这是已文档化边界，非缺陷。
- **unarmed（CON-05）**：守卫未 armed 时（如禁用 hdc 插件），shim_allow/trusted_exec 记 `skipped`，deny canaries 照常执行。
- **canary 失败负缓存 10s**：失败后 10s 内重试直接 fail-closed 不再发探针；10s 后自动重试（自愈）。
- **首批延迟**：canary 1–3s + hdc server 冷启动，仅会话内首次。

## 6. 结果回执模板

| 用例 | 结果（通过/失败/边界符合预期/跳过） | 实际退出码/关键输出 | 备注 |
|---|---|---|---|
| 场景类型 | A / B | deveco.json network 配置 | |
| M0 配置就绪 | | | 缺配置时后续全部 bypassed |
| M1 canary 结果 | | | 四项状态（场景 A trusted_exec=skipped） |
| M2 读取拒绝 | | | |
| M3 exec 拒绝 | | | |
| M4 复制阻断 | | | |
| M5 shim 调用 | | | 场景 A 记 guard_unavailable |
| M6 缓存生效 | | | 二次耗时 |
| M7/M8 设备调用 | | | 无设备可跳过；场景 A 记边界 |
| full-access 旁路 | | | host_enforcement 值 |
