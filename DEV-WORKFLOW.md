# Git 开发工作流

> 代码从功能分支单向流向开发分支，保持提交历史线性整洁。

## 分支模型

| 分支 | 角色 | 生命周期 | 说明 |
|------|------|----------|------|
| `master` | 生产环境 | 永久 | 仅通过发布流程合入，禁止直接推送。详见 [RELEASE-WORKFLOW.md](./RELEASE-WORKFLOW.md) |
| `develop` | 主开发 | 永久 | 新特性合入目标，上游同步在此进行 |
| `<short-description>` | 功能 | 临时 | 从 `develop` 检出，PR 合回。分支命名格式见下方 |

分支命名格式：`<short-description>`

- 最多 3 个词，短横线分隔，仅含 `[a-z0-9-]`
- 不使用斜杠或类型前缀（如 `feat/`、`fix/`）

示例：`login-auth`、`startup-crash`、`bundle-size`、`add-release-job`、`auth-refactor`

## 日常开发

```text
<short-description> ──PR──▶ develop
```

1. 从 `develop` 创建功能分支
2. 开发过程中定期同步上游：`git pull --rebase origin develop`
3. 开发完成提交 PR，目标 `develop`
4. 通过 CI 和 Code Review 后合入

## Commit 规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

**格式：** `<type>(<scope>)!?: <description>`

- `<type>`：变更类型，见下表
- `(<scope>)`：可选，影响范围
- `!`：可选，表示 Breaking Change（不兼容变更）
- `<description>`：标题描述，1-72 个字符

| 类型 | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `chore` | 杂项（不改变功能的零碎工作） |
| `style` | 代码风格（格式、标点、不影响逻辑） |
| `refactor` | 重构（不改变行为） |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `build` | 构建系统、依赖管理 |
| `ci` | CI/CD 配置 |
| `revert` | 回滚提交 |

标题示例：

```text
feat(deveco): add dark mode
fix(deveco)!: rename config schema field
perf: optimize large file parsing
```

正文示例（聚焦需求核心，编号列表，不罗列实现细节）：

```text
feat(deveco): add user profile page

1. support viewing personal profile with avatar and bio
2. support editing nickname and bio

Signed-off-by: YourName <your.email@example.com>
```

提交内容规范：

1. **标题**：`<type>[(<scope>)][!]: <描述>`
   - `scope` 可选，通常为 `packages/` 下的目录名（如 `deveco`、`app`、`desktop`）；跨包变更可省略
   - 避免出现 `opencode` 字样，包名为 opencode 时替换为 `deveco`
   - `!` 可选，置于 `:` 前表示 Breaking Change
   - `<描述>` 不超过 72 个字符
2. **正文**：可选，编号列表，简洁扼要，重点描述需求/功能核心而非实现步骤
3. **签名**：必须包含 `Signed-off-by: YourName <your.email@example.com>`，不添加 `Co-Authored-By`
4. **粒度**：每个 commit 聚焦一个逻辑变更，避免混合不相关的修改
5. **语言**：中英文均可，保持同一 commit 内一致

## Issue 规范

创建 Issue 必须使用 `.gitcode/ISSUE_TEMPLATE/` 中对应类型的模板，按模板字段逐项填写，不得省略必填字段、不得自创字段名。

| commit type | 模板文件 | 标题前缀 |
|---|---|---|
| `feat` | `feature-request.yml` | `[Feature]` |
| `fix` | `bug-report.yml` | `[Bug]` |
| `docs` / `chore` / `build` / `ci` | `document.yml` | `[Document]` |
| `refactor` / `test` / `perf` / `style` | `refactor.yml` | `[Refactor]` |

- 标题须以模板要求的前缀开头
- body 中每个字段格式为 `### <label>\n\n<内容>`，末尾附检查清单（所有项勾选 `[x]`）
- 缺失的版本/系统信息写 `未提供`

## PR 规范

创建 PR 必须使用 `.gitcode/pull_request_template.md` 模板，保留所有章节标题，逐项填写：

1. **Issue for this PR**：填写 `Closes #<issue_number>`
2. **Type of change**：勾选与 commit type 对应的选项（仅一项 `[x]`）
3. **What does this PR do?**：简述变更内容和原因
4. **How did you verify your code works?**：描述验证方式
5. **Screenshots / recordings**：UI 变更附截图，非 UI 变更写 `N/A`
6. **Checklist**：逐项确认并勾选

不得省略章节、不得自创格式。不遵循模板的 PR 将被自动拒绝。

## PR 检查清单

提交 PR 前确认以下事项：

- [ ] 代码通过类型检查（根目录运行 `bun turbo typecheck`，或从包目录运行 `bun typecheck`）
- [ ] Commit 符合 Conventional Commits 规范
- [ ] Issue 使用了正确的模板且必填字段完整
- [ ] PR 正文遵循 `.gitcode/pull_request_template.md` 模板

## 代码拉取

默认从上游主仓（`git@gitcode.com:openharmony-sig/deveco-code.git`）的 `develop` 分支拉取（rebase 方式）：

```bash
# 添加 upstream remote（首次）
git remote add origin git@gitcode.com:openharmony-sig/deveco-code.git

# 拉取
git pull --rebase origin develop
```

避免无意义的 merge commit。
