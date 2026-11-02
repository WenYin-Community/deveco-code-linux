#!/bin/bash
# close-stale-issues.sh — 关闭长期没有更新的 Issue
#
# 只处理 Issue（跳过 PR）。按 updated_at 判定，超过阈值就「先评论说明原因，再关闭」，
# 评论带 <!-- stale-issue --> 标记，重复运行不会刷第二条。
#
# 环境变量：
#   GITCODE_API / GITCODE_REPO / GITCODE_TOKEN  由 workflow 注入
#   STALE_DAYS  判定阈值，默认 30
#   MAX_CLOSE   单次最多关闭数量，默认 50（避免一次误伤太多）
#   DRY_RUN     1/true 时只打印将要关闭的 Issue，不发评论也不关闭

set -euo pipefail

API="${GITCODE_API:?GITCODE_API not set}"
REPO="${GITCODE_REPO:?GITCODE_REPO not set}"
TOKEN="${GITCODE_TOKEN:?GITCODE_TOKEN not set}"

STALE_DAYS="${STALE_DAYS:-30}"
MAX_CLOSE="${MAX_CLOSE:-50}"

if ! [[ "$STALE_DAYS" =~ ^[0-9]+$ ]]; then
  echo "STALE_DAYS 不是数字（$STALE_DAYS），回退到 30" >&2
  STALE_DAYS=30
fi
if ! [[ "$MAX_CLOSE" =~ ^[0-9]+$ ]]; then
  echo "MAX_CLOSE 不是数字（$MAX_CLOSE），回退到 50" >&2
  MAX_CLOSE=50
fi

case "${DRY_RUN:-0}" in
  1 | true | TRUE | yes) DRY_RUN=1 ;;
  *) DRY_RUN=0 ;;
esac

API_SCRIPT="$(dirname "$0")/gitcode-api.sh"
THRESHOLD=$((STALE_DAYS * 86400))
NOW=$(date +%s)

CHECKED=0
CLOSED=0
SKIPPED=0

to_epoch() {
  python3 -c '
import sys
from datetime import datetime
try:
    print(int(datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()))
except Exception:
    print(0)
' "$1"
}

echo "扫描 open Issue：阈值 ${STALE_DAYS} 天，单次上限 ${MAX_CLOSE} 个，DRY_RUN=${DRY_RUN}"

for PAGE in $(seq 1 20); do
  ISSUES=$(curl -sS -H "Authorization: Bearer $TOKEN" \
    "$API/repos/$REPO/issues?state=open&per_page=100&page=$PAGE" \
    | tr -d '\000-\010\013-\037') || break

  PAGE_COUNT=$(printf '%s' "$ISSUES" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)
  if [ "$PAGE_COUNT" -eq 0 ]; then
    break
  fi

  # 用占位符代替空字段：read 会把连续制表符当成一个分隔符，空值会让列错位
  ROWS=$(printf '%s' "$ISSUES" | jq -r '
    .[]
    | select(.pull_request == null)
    | select(((.labels // []) | map(if type == "object" then (.name // "") else . end)) | index("keep-open") | not)
    | [.number,
       ((.updated_at // "") | if . == "" then "-" else . end),
       (((.title // "") | gsub("[\t\n\r]"; " ")) | if . == "" then "(无标题)" else . end)]
    | @tsv' 2>/dev/null || true)

  while IFS=$'\t' read -r NUMBER UPDATED_AT TITLE; do
    if [ -z "$NUMBER" ]; then
      continue
    fi

    CHECKED=$((CHECKED + 1))

    if [ "$UPDATED_AT" = "-" ]; then
      echo "  #$NUMBER: 缺少 updated_at，跳过"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    UPDATED_EPOCH=$(to_epoch "$UPDATED_AT")
    if [ "$UPDATED_EPOCH" -eq 0 ]; then
      echo "  #$NUMBER: 无法解析 updated_at（$UPDATED_AT），跳过"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    AGE=$((NOW - UPDATED_EPOCH))
    if [ "$AGE" -lt "$THRESHOLD" ]; then
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    AGE_DAYS=$((AGE / 86400))

    if [ "$CLOSED" -ge "$MAX_CLOSE" ]; then
      echo "  #$NUMBER: 已达单次关闭上限 $MAX_CLOSE，留到下次运行"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    if [ "$DRY_RUN" = "1" ]; then
      echo "  [DRY_RUN] #$NUMBER 已 $AGE_DAYS 天未更新，将会关闭：$TITLE"
      CLOSED=$((CLOSED + 1))
      continue
    fi

    echo "  #$NUMBER 已 $AGE_DAYS 天未更新，关闭中：$TITLE"

    # 先留关闭原因，再关闭；已有同标记评论时只关闭不重复留言
    if ! EXISTING=$(GITCODE_TYPE=issues bash "$API_SCRIPT" list-comments "$NUMBER" 2>/dev/null); then
      echo "  #$NUMBER: 读取评论失败，跳过（下次扫描重试）"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    if printf '%s' "$EXISTING" | grep -q '<!-- stale-issue -->'; then
      echo "  #$NUMBER: 已有关闭原因评论，只关闭不重复留言"
    else
      COMMENT=$(cat <<EOF
<!-- stale-issue -->
## 自动关闭：${STALE_DAYS} 天无更新

这个 Issue 已经 **${AGE_DAYS} 天**没有新的活动（最后更新：\`${UPDATED_AT}\`），因此将被自动关闭。

**如果你仍需要跟进：**
- 直接在本 Issue 下回复补充信息，或新建一个 Issue 并引用本编号，我们会重新评估
- 关闭不影响历史讨论，内容仍然可查

**如果这是一个长期有效的跟踪项：** 给 Issue 加上 \`keep-open\` 标签即可跳过自动关闭。

判断依据见[贡献指南](https://atomgit.com/openharmony-sig/deveco-code/blob/develop/CONTRIBUTING.md)。如有异议请联系维护者。
EOF
)
      if ! printf '%s' "$COMMENT" | GITCODE_TYPE=issues bash "$API_SCRIPT" post-comment "$NUMBER" >/dev/null; then
        echo "  #$NUMBER: 发布关闭原因失败，跳过关闭"
        SKIPPED=$((SKIPPED + 1))
        continue
      fi
    fi

    if ! GITCODE_TYPE=issues bash "$API_SCRIPT" close-issue "$NUMBER" >/dev/null; then
      echo "  #$NUMBER: 关闭失败，跳过"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    CLOSED=$((CLOSED + 1))
  done <<< "$ROWS"

  if [ "$PAGE_COUNT" -lt 100 ]; then
    break
  fi
done

echo ""
echo "检查 $CHECKED 个 Issue，$( [ "$DRY_RUN" = "1" ] && echo "预览" || echo "关闭" ) $CLOSED 个，跳过 $SKIPPED 个"

if [ -n "${ATOMGIT_STEP_SUMMARY:-}" ]; then
  {
    echo "## 关闭长期未更新 Issue"
    echo ""
    echo "| 项目 | 值 |"
    echo "|------|------|"
    echo "| 检查时间 | $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S') |"
    echo "| 阈值 | ${STALE_DAYS} 天 |"
    echo "| 模式 | $( [ "$DRY_RUN" = "1" ] && echo "预览（未实际关闭）" || echo "执行" ) |"
    echo "| 检查数 | $CHECKED |"
    echo "| 关闭数 | $CLOSED |"
    echo "| 跳过数 | $SKIPPED |"
  } >> "$ATOMGIT_STEP_SUMMARY"
fi
