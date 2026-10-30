#!/bin/bash
# dispatch-assigned-issues.sh — 把指派给指定负责人（默认 deveco-agent）的 Issue 转交给 Multica
#
# Issue 评论事件在平台上不可用，所以改成定时轮询。流程分两段：
#   1. 收集：分页扫 open Issue，按负责人过滤，排掉 PR 条目和已派发过的（看标记评论），
#      结果放进 CANDIDATES 数组；
#   2. 派发：对数组逐个取详情、组装 payload、POST webhook，成功后在 Issue 留
#      <!-- ai-issue-dispatched --> 标记，下次运行就不会重复派发（要重新派发删掉该评论）。
#
# 环境变量：
#   GITCODE_API / GITCODE_REPO / GITCODE_TOKEN  由 workflow 注入
#   MULTICA_WEBHOOK  Multica autopilot 的 webhook_url
#   ASSIGNEE         负责人，默认 deveco-agent
#   MAX_DISPATCH     单次最多派发数量，默认 10
#   DRY_RUN          1/true 时只打印，不发请求

set -euo pipefail

API="${GITCODE_API:?GITCODE_API not set}"
REPO="${GITCODE_REPO:?GITCODE_REPO not set}"
TOKEN="${GITCODE_TOKEN:?GITCODE_TOKEN not set}"
WEBHOOK="${MULTICA_WEBHOOK:?MULTICA_WEBHOOK not set}"

ASSIGNEE="${ASSIGNEE:-deveco-agent}"
MAX_DISPATCH="${MAX_DISPATCH:-10}"

if ! [[ "$MAX_DISPATCH" =~ ^[0-9]+$ ]]; then
  echo "MAX_DISPATCH 不是数字（$MAX_DISPATCH），回退到 10" >&2
  MAX_DISPATCH=10
fi

case "${DRY_RUN:-0}" in
  1 | true | TRUE | yes) DRY_RUN=1 ;;
  *) DRY_RUN=0 ;;
esac

MARKER='<!-- ai-issue-dispatched -->'
API_SCRIPT="$(dirname "$0")/gitcode-api.sh"

CANDIDATES=()
SEEN=""
CHECKED=0
SKIPPED=0

# ---------- 第一段：收集待派发的 Issue ----------

echo "扫描 open Issue：负责人 ${ASSIGNEE}，单次上限 ${MAX_DISPATCH}，DRY_RUN=${DRY_RUN}"

for PAGE in $(seq 1 10); do
  ISSUES=$(curl -sS -H "Authorization: Bearer $TOKEN" \
    "$API/repos/$REPO/issues?state=open&per_page=100&page=$PAGE" \
    | tr -d '\000-\010\013-\037') || break

  PAGE_COUNT=$(printf '%s' "$ISSUES" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)
  if [ "$PAGE_COUNT" -eq 0 ]; then
    break
  fi

  # 用占位符代替空字段，避免 read 把连续制表符当成一个分隔符导致列错位
  ROWS=$(printf '%s' "$ISSUES" | jq -r --arg a "$ASSIGNEE" '
    .[]
    | select(.pull_request == null)
    | select(
        ([ (.assignees // [])[], (.assignee // empty) ]
          | map(if type == "object" then (.login // .username // "") else . end)
          | index($a)) != null)
    | [.number, (((.title // "") | gsub("[\t\n\r]"; " ")) | if . == "" then "(无标题)" else . end)]
    | @tsv' 2>/dev/null || true)

  while IFS=$'\t' read -r NUMBER TITLE; do
    if [ -z "$NUMBER" ]; then
      continue
    fi

    # 分页边界可能重复，去重
    case " $SEEN " in
      *" $NUMBER "*) continue ;;
    esac
    SEEN="$SEEN $NUMBER"
    CHECKED=$((CHECKED + 1))

    if ! EXISTING=$(GITCODE_TYPE=issues bash "$API_SCRIPT" list-comments "$NUMBER" 2>/dev/null); then
      echo "  #$NUMBER: 读取评论失败，跳过（下次运行重试）"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    if printf '%s' "$EXISTING" | grep -q "$MARKER"; then
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    CANDIDATES+=("$NUMBER"$'\t'"$TITLE")
  done <<< "$ROWS"

  if [ "$PAGE_COUNT" -lt 100 ]; then
    break
  fi
done

CANDIDATE_COUNT=${#CANDIDATES[@]}
echo "收集完成：检查 $CHECKED 个指派给 ${ASSIGNEE} 的 Issue，待派发 $CANDIDATE_COUNT 个，跳过 $SKIPPED 个"

# ---------- 第二段：逐个派发 ----------

SENT=0

for ITEM in ${CANDIDATES[@]+"${CANDIDATES[@]}"}; do
  NUMBER="${ITEM%%$'\t'*}"
  TITLE="${ITEM#*$'\t'}"

  if [ "$SENT" -ge "$MAX_DISPATCH" ]; then
    REMAINING=$((CANDIDATE_COUNT - SENT))
    echo "已达单次派发上限 $MAX_DISPATCH，剩余 $REMAINING 个留到下次运行"
    SKIPPED=$((SKIPPED + REMAINING))
    break
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "  [DRY_RUN] #$NUMBER 会转交：$TITLE"
    SENT=$((SENT + 1))
    continue
  fi

  echo "  #$NUMBER 转交中：$TITLE"

  ISSUE_DATA=$(curl -sS -H "Authorization: Bearer $TOKEN" \
    "$API/repos/$REPO/issues/$NUMBER" \
    | tr -d '\000-\010\013-\037') || ISSUE_DATA=""

  if ! printf '%s' "$ISSUE_DATA" | jq -e '.number' >/dev/null 2>&1; then
    echo "  #$NUMBER: 取详情失败，跳过"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  PAYLOAD=$(printf '%s' "$ISSUE_DATA" | jq -c --arg assignee "$ASSIGNEE" --arg repo "$REPO" '
    {
      action: "reopened",
      object_kind: "note",
      event_type: "note",
      number: .number,
      repository: {
        full_name: $repo,
        html_url: ("https://gitcode.com/" + $repo),
        clone_url: ("https://gitcode.com/" + $repo + ".git")
      },
      issue: {
        iid: .number,
        number: .number,
        title: .title,
        description: .body,
        state: (if .state == "open" then "opened" else .state end),
        url: .html_url,
        author: {username: .user.login},
        labels: [(.labels // [])[] | if type == "object" then .name else . end]
      },
      object_attributes: {
        note: "/ai issue fix",
        description: "/ai issue fix",
        noteable_type: "Issue",
        iid: .number,
        title: .title
      },
      user: {username: $assignee}
    }')

  CODE=$(curl -sS -o /tmp/dispatch-resp.txt -w "%{http_code}" -X POST "$WEBHOOK" \
    -H "Content-Type: application/json" \
    --data "$PAYLOAD" || echo "000")

  if [ "$CODE" != "200" ]; then
    echo "  #$NUMBER: webhook 返回 HTTP $CODE，跳过（不写标记，下次重试）"
    head -c 300 /tmp/dispatch-resp.txt 2>/dev/null || true
    echo
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # 先写标记再计数：标记失败会导致下次重复派发，所以这里要能看见
  COMMENT=$(cat <<EOF
$MARKER
🤖 已转交给 \`${ASSIGNEE}\` 处理。

如需重新转交，删除本条评论即可。
EOF
)

  if ! printf '%s' "$COMMENT" | GITCODE_TYPE=issues bash "$API_SCRIPT" post-comment "$NUMBER" >/dev/null; then
    echo "  #$NUMBER: 已派发但写标记失败，下次运行可能重复派发"
  fi

  SENT=$((SENT + 1))
done

echo ""
echo "检查 $CHECKED 个指派给 ${ASSIGNEE} 的 Issue，派发 $SENT 个，跳过 $SKIPPED 个"

if [ -n "${ATOMGIT_STEP_SUMMARY:-}" ]; then
  {
    echo "## 转交指派给 ${ASSIGNEE} 的 Issue"
    echo ""
    echo "| 项目 | 值 |"
    echo "|------|------|"
    echo "| 检查时间 | $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S') |"
    echo "| 负责人 | ${ASSIGNEE} |"
    echo "| 模式 | $( [ "$DRY_RUN" = "1" ] && echo "预览（未实际转发）" || echo "执行" ) |"
    echo "| 检查数 | $CHECKED |"
    echo "| 候选数 | $CANDIDATE_COUNT |"
    echo "| 派发数 | $SENT |"
    echo "| 跳过数 | $SKIPPED |"
  } >> "$ATOMGIT_STEP_SUMMARY"
fi
