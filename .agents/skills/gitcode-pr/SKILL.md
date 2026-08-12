---
name: gitcode-pr
description: 按仓库 DEV-WORKFLOW.md 完成 DevEco Code 的 GitCode 提交、推送、上游 Issue/PR 关联及 CI 触发。当用户在 DevEco Code 或 openharmony-sig/deveco-code 仓库上下文中要求提交代码、提交当前改动、创建提交、推送代码或创建 PR 时使用；即使用户未提及 GitCode 或 PR，只要要求提交代码也必须触发。所有 GitCode API 操作通过 .gitcode/scripts/gitcode-api.sh 完成，无需 MCP。功能分支固定基于父仓库 develop，推送到 origin，不验证 Fork 关系。
---

# DevEco Code GitCode 提交流程

使用中文与用户沟通。按顺序执行门禁；任一门禁失败，立即停止依赖它的操作。

## 0. Token 门禁

触发本 skill 后，从 git remote 提取 Token 并验证。不得跳过、不得在对话中回显 Token。

```bash
TOKEN=$(git remote get-url origin | sed -n 's|https://[^:]*:\([^@]*\)@.*|\1|p')
```

- Token 为空或验证失败：停止，询问用户是否通过 `git remote set-url origin` 配置带 Token 的 remote URL。
- 不得用其他方式获取 Token，不得安装依赖、修改配置或索取 Token。

验证方式：用提取的 Token 调用 `gitcode-api.sh get-issue 1` 检查 HTTP 响应非 401。

```bash
export GITCODE_API=https://api.gitcode.com/api/v5
export GITCODE_REPO=openharmony-sig/deveco-code
export GITCODE_TOKEN="$TOKEN"
bash .gitcode/scripts/gitcode-api.sh get-issue 1 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print('AUTH OK' if 'error_code' not in d or d.get('error_code')!=401 else 'AUTH FAIL')"
```

## 1. 仓库与规则门禁

通过 Token 门禁后，仅执行只读检查，直至本节全部通过：

1. 定位仓库根目录，完整读取当前版本的 `DEV-WORKFLOW.md`；不得依赖记忆、摘要、历史会话或旧版本。
2. 确认 `origin`、工作区、暂存区和 Git 用户身份；保留无关的已暂存、未暂存和未跟踪文件。
3. 提取并应用分支命名、Commit 标题与正文、提交粒度、必做检查及 Issue/PR 流程。
4. 按当前指令优先级执行：系统、开发者及适用的 `AGENTS.md` 高于本 skill；本 skill 的固定约束高于 `DEV-WORKFLOW.md` 的普通约定。

`DEV-WORKFLOW.md` 缺失、无法完整读取、含义不明确或规则冲突时，列出相关原文与影响并请求用户裁决。门禁通过前不得切换或创建分支、暂存、提交、推送、创建 Issue/PR，或执行其他写操作。

## 固定约束

- 父项目：`openharmony-sig/deveco-code`
- 父项目 URL：`https://gitcode.com/openharmony-sig/deveco-code.git`
- 分支基线和 PR 目标：父项目 `develop`
- 推送目标：`origin`；不得验证或推断其 Fork 关系，不得向父项目推送
- 所有 GitCode API 操作通过 `bash .gitcode/scripts/gitcode-api.sh` 完成，环境变量 `GITCODE_API`、`GITCODE_REPO`、`GITCODE_TOKEN` 在 Step 0 设置

## 2. 基线与分支

1. 运行：

   ```bash
   git fetch --no-tags https://gitcode.com/openharmony-sig/deveco-code.git refs/heads/develop
   ```

2. 运行 `git switch --create <feature_branch> FETCH_HEAD` 并验证起点。不得复用、重置或覆盖同名本地分支。

允许 Git 保留不冲突的未提交改动。切换失败时停止；不得 stash、丢弃、覆盖、merge、rebase、reset 或强制切换。

## 3. 提交与推送

1. 只暂存用户确认的路径；不得使用 `git add -A`。
2. 按 `DEV-WORKFLOW.md` 完成必做检查并生成 Commit 标题与正文。
3. 使用 Git 用户身份生成 `Signed-off-by`；允许存在 `Co-authored-by`。
4. 保持仓库 hooks 启用，使用 `git commit -s`，不得默认绕过 hook。
5. 验证提交内容、trailers 和签名后，运行 `git push --set-upstream origin <feature_branch>`。

hook、检查、提交验证或推送失败时停止后续流程。

## 4. Issue 与 PR

1. 查询 `<origin_owner>:<feature_branch>` → `develop` 的开放 PR：

   ```bash
   ORIGIN_OWNER=$(git remote get-url origin | sed -n 's|.*\.com/\([^/]*\)/.*|\1|p')
   bash .gitcode/scripts/gitcode-api.sh list-prs open "${ORIGIN_OWNER}:${feature_branch}" develop
   ```

   返回非空数组时复用，不重复创建。

2. 不存在时，按提交类型选择上游 Issue 模板：`feat` → `feature-request`、`fix` → `bug-report`、`docs` → `document`、`refactor` → `refactor`、`chore|test` → `question`。
3. 优先使用 `.gitcode/ISSUE_TEMPLATE/`，其次使用 `.github/ISSUE_TEMPLATE/`。保留模板默认值，只填写已验证信息，缺失项写 `未提供`。
4. 创建 Issue：

   ```bash
   echo "$ISSUE_BODY" | bash .gitcode/scripts/gitcode-api.sh create-issue "$ISSUE_TITLE"
   ```

   从响应中提取 Issue 编号。

5. 创建 PR，body 中包含 `Closes #<issue_number>` 以自动关联：

   ```bash
   echo "$PR_BODY" | bash .gitcode/scripts/gitcode-api.sh create-pr "$PR_TITLE" "${ORIGIN_OWNER}:${feature_branch}" develop
   ```

6. 验证关联：

   ```bash
   bash .gitcode/scripts/gitcode-api.sh list-linked-issues "$PR_NUMBER"
   ```

模板、创建或关联验证失败时停止。

## 5. CI 构建

仅处理本次新建的 PR：

1. 创建 PR 后立即查询评论；之后每 30 秒查询一次，最多等待 3 分钟。

   ```bash
   GITCODE_TYPE=pulls bash .gitcode/scripts/gitcode-api.sh list-comments "$PR_NUMBER"
   ```

2. 仅接受作者为 `openharmony_ci` 且正文包含 `感谢提交 Pull Requests` 的评论。
3. 评论出现后，若认证用户尚未发送正文精确等于 `start build` 的评论，则发送一次：

   ```bash
   echo "start build" | GITCODE_TYPE=pulls bash .gitcode/scripts/gitcode-api.sh post-comment "$PR_NUMBER"
   ```

4. 等待超时不得发送构建指令。

## 结果报告

报告 Token 验证状态、基线哈希、本地分支起点、提交、hooks、推送分支、Issue/PR、关联、CI 评论及构建指令状态。失败时同时报告停止阶段、原因和相关路径。
