# Memory Plugin Optimization Roadmap

## 一、稳定性/正确性优化

### 🔴 高优先级

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| 1 | session.fork 3s 延迟是 workaround | `forkManager.ts` | 根本原因是平台层 `halt()` 在 `cleanup()` 完成前设置 idle。应推动平台修复（idle 应在 cleanup 后），移除延迟 |
| 2 | extraction fork 可能 token 爆炸 | `extractionAgent.ts` | `session.fork` 复制父会话全部对话历史，长对话会导致子会话 context 超限。应限制 fork 时的消息数量或截断 |
| 3 | pendingContext.messages 始终为空 | `extractionRunner.ts:363` | `ExtractionPendingContext` 接口有 `messages` 字段但从未填充，是死代码。要么移除要么利用 |
| 4 | extraction lock 未在所有失败路径释放 | `extractionRunner.ts` | 部分 early return 路径（如 `prompt_failed`）没有释放 lock，依赖 stale timeout 兜底 |

### 🟡 中优先级

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| 5 | config 热更新不支持 | `index.ts` | `memory-config.json` 只在插件初始化时读取一次，修改后需重启 deveco。可实现 `config` hook 或文件监听 |
| 6 | skill review 在 tool.execute.after 触发 | `index.ts:568` | 会话仍在处理时 fork，存在竞态风险。应改为 idle 时检查 flag 延迟触发（和 extraction 一样） |
| 7 | 记忆去重不够智能 | `extractionPrompt.ts` | 提取 agent 只靠 prompt 指令检查重复，无程序化去重。可在写入前做 embedding 相似度检查 |
| 8 | memoryRecall 每次 turn 都做 semantic search | `index.ts` messages.transform | 即使无关消息（如 "好的"）也触发 BM25 + LLM 语义选择，浪费 token。可加关键词预过滤 |
| 9 | Auto Dream session 计数不跨进程持久化 | `dreamState.ts` | `sessionCount` 在内存中，进程重启后丢失。已有 `.auto-dream-state.json` 但写入时机不稳定 |

### 🟢 低优先级

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| 10 | closure state pattern 全局可变状态 | `extractionRunner.ts` | `initializedClient`、`initializedStorage` 等模块级变量，多项目实例时会冲突。应改为 stateMap 统一管理 |
| 11 | forkManager/subagentManager 内存泄漏 | `forkManager.ts` | `activeForkSessionIDs` 和 `taskSubagentSessionIDs` 是 in-memory Set，进程重启后丢失。已完成但未 unregister 的 session 不会被清理 |
| 12 | 日志级别控制不统一 | 各模块 | 有的用 `logger.info`，有的用 `logger.debug`，没有按模块区分级别。可支持 per-module 日志级别 |
| 13 | extractionPrompt 硬编码版本 "2.0.0" | `extractionPrompt.ts:41` | 版本号未实际用于任何逻辑，是死常量 |
| 14 | 重复的 lock 释放指令 | `extractionPrompt.ts` + `prompts.ts` | extraction lock 和 skill-review lock 的释放指令各自有一份几乎相同的 `buildLockReleaseSection`，可提取共享 |
| 15 | memory-write 工具的 content 参数无长度限制 | `index.ts` tool 定义 | 可写入任意大小的 content，可能导致注入时截断。应在写入时限制 |

---

## 二、功能特性优化

### 🔴 核心体验缺失

| # | 特性 | 现状 | 建议 |
|---|------|------|------|
| 1 | 记忆搜索无对话内工具引导 | `memory-search` 存在但 prompt 中未引导 agent 主动使用 | 在 system prompt 中引导 agent 在回答不确定时主动 `memory-search` |
| 2 | 记忆更新/修正无便捷方式 | 用户说"不对"时，agent 需先 read 再 write 覆盖 | 增加 `memory-update` 工具或在 `memory-write` 中支持 merge 模式（追加而非覆盖） |
| 3 | 记忆无优先级/权重 | 所有记忆平等注入，靠 LLM 自己判断相关性 | 支持 `priority` 字段，高优先级记忆始终注入，低优先级仅召回时注入 |
| 4 | 用户无法查看当前记忆列表 | 需要打 `memory-read` 工具调用 | 支持 `/memories` 斜杠命令直接列出所有记忆 |

### 🟡 智能程度不足

| # | 特性 | 现状 | 建议 |
|---|------|------|------|
| 5 | 记忆无自动过期提醒 | TTL 到期后静默进入 pending-expiry，用户不知道 | 在 session 开始时 toast 提示"有 N 条记忆即将过期，输入 /dream-approve 确认删除" |
| 6 | 跨项目记忆隔离过严 | `storageMode: global` 按 projectID 分目录 | 支持 `shared` 模式：用户偏好（type=user）跨项目共享，项目上下文（type=project）隔离 |
| 7 | 记忆无版本历史 | write 直接覆盖，无法回滚 | 写入时保留 `.bak` 或 git 追踪记忆文件变更 |
| 8 | extraction 无法增量提取 | 每次提取分析全部对话历史 | 记录 lastProcessedMessageId，只提取新增消息，减少 token 消耗 |
| 9 | 记忆冲突无检测 | 两条记忆可能矛盾（如"用 TypeScript" vs "用 JavaScript"） | 写入时检查语义冲突，提示 agent 更新旧记忆而非新建 |

### 🟢 增值功能

| # | 特性 | 现状 | 建议 |
|---|------|------|------|
| 10 | 记忆导入/导出 | 无 | 支持 `/memory-export` 导出为 JSON/Markdown，`/memory-import` 批量导入 |
| 11 | 记忆统计/健康度 | 仅 `memory-read` 的 stats 行 | 支持 `/memory-stats` 显示：总量、按类型分布、过期数量、最近提取时间、存储空间 |
| 12 | 对话内记忆引用标记 | 召回的记忆注入后无法追踪哪些被实际使用 | agent 使用记忆时标记 `lastUsed` 时间戳，长期未使用的记忆降权 |
| 13 | 条件注入 | 所有相关记忆都注入 | 支持记忆附带 `triggers` 字段（如文件路径模式、关键词），仅在匹配上下文时注入 |
| 14 | 记忆分组/标签 | 仅有 type（user/feedback/project/reference） | 支持自定义 `tags` 字段，如 `["frontend", "react"]`，用于精准召回 |
| 15 | 多语言记忆 | 记忆语言和用户语言可能不一致 | 记忆自动使用用户的主要语言写入，跨语言场景可配 `language` 字段 |

---

## 三、建议实施顺序

### 第一批（投入产出比最高）
1. `/memories` 斜杠命令 — 改动小，体验提升大
2. 跨项目共享用户偏好（type=user） — 当前隔离不合理
3. 增量提取 — 直接减少 extraction token 消耗 50%+
4. 过期提醒 toast — 代码已有 `showPendingExpiryToast`，只需确保在 session 启动时调用

### 第二批（稳定性提升）
5. extraction fork token 截断 — 长对话场景下防止报错
6. skill review 延迟到 idle 触发 — 消除竞态
7. config 热更新 — 免重启

### 第三批（智能化）
8. 记忆冲突检测
9. 语义去重（embedding 相似度）
10. 记忆使用追踪 + 降权

---

*Generated: 2026-07-08*
