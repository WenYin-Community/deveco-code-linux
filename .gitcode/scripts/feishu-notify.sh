#!/bin/bash
# feishu-notify.sh — Feishu webhook notification sender
#
# Usage: bash feishu-notify.sh <command>
# Data is read from FEISHU_DATA env var (JSON string).

show_help() {
  cat <<'HELP'
feishu-notify.sh — Feishu webhook notification sender

Usage: bash feishu-notify.sh <command>

Environment:
  FEISHU_DATA     JSON string with notification data (required)
  FEISHU_WEBHOOK  Webhook URL (required to send)
  GITCODE_OWNER   GitCode repo owner (default: openharmony-sig)
  GITCODE_REPO    GitCode repo name (default: deveco-code)
  ATOMGIT_STEP_SUMMARY  Step summary file (optional)

Commands:
  release   发布完成通知
            data: {tag, scope, channel, branch, packages}
            packages: 多行字符串，每行一个包的 markdown 链接

  custom    自定义通知
            data: {title, content, template}
            template: green(默认), blue, red, yellow, grey

Examples:
  FEISHU_DATA='{"tag":"v0.1.4","scope":"deveco","channel":"latest","branch":"develop","packages":"• pkg1\n• pkg2"}' \
    bash feishu-notify.sh release

  FEISHU_DATA='{"title":"⚠️ 警告","content":"构建失败","template":"red"}' \
    bash feishu-notify.sh custom
HELP
}

CMD="${1:-}"
if [ "$CMD" = "-h" ] || [ "$CMD" = "--help" ] || [ "$CMD" = "help" ]; then
  show_help
  exit 0
fi

set -euo pipefail

DATA="${FEISHU_DATA:-}"
WEBHOOK="${FEISHU_WEBHOOK:-}"
GITCODE_OWNER="${GITCODE_OWNER:-openharmony-sig}"
GITCODE_REPO="${GITCODE_REPO:-deveco-code}"
SUMMARY="${ATOMGIT_STEP_SUMMARY:-}"

if [ -z "$DATA" ]; then
  echo "FEISHU_DATA not set, skipping notification"
  exit 0
fi

send_card() {
  if [ -z "$WEBHOOK" ]; then
    echo "FEISHU_WEBHOOK not set, skipping notification"
    return 0
  fi
  curl -sS -X POST -H "Content-Type: application/json" -d "$1" "$WEBHOOK"
}

write_summary() {
  [ -n "$SUMMARY" ] || return 0
  echo "$1" >> "$SUMMARY"
}

case "$CMD" in
  release)
    TAG=$(echo "$DATA" | jq -r '.tag')
    SCOPE=$(echo "$DATA" | jq -r '.scope')
    CHANNEL=$(echo "$DATA" | jq -r '.channel')
    BRANCH=$(echo "$DATA" | jq -r '.branch')
    PACKAGES=$(echo "$DATA" | jq -r '.packages // empty')

    if [ -z "$PACKAGES" ]; then
      VERSION="${TAG#v}"
      PACKAGES="• [@${SCOPE}/deveco-code@${VERSION}](https://www.npmjs.com/package/@${SCOPE}/deveco-code)"
    fi

    NPM_URL="https://www.npmjs.com/package/@${SCOPE}/deveco-code"
    RELEASE_URL="https://gitcode.com/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${TAG}"
    BUILD_TIME=$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S')

    PAYLOAD=$(jq -n \
      --arg tag "$TAG" \
      --arg channel "$CHANNEL" \
      --arg scope "$SCOPE" \
      --arg packages "$PACKAGES" \
      --arg npm_url "$NPM_URL" \
      --arg release_url "$RELEASE_URL" \
      --arg branch "$BRANCH" \
      --arg build_time "$BUILD_TIME" \
      '{
        msg_type: "interactive",
        card: {
          header: {
            title: {tag: "plain_text", content: "✅ DevEco Code \($tag) 发布完成"},
            template: "green"
          },
          elements: [
            {tag: "div", text: {tag: "lark_md", content: "**版本**: \($tag)\n**Channel**: \($channel)\n**Scope**: @\($scope)\n**分支**: \($branch)\n**出包时间**: \($build_time)\n**安装**: npm i -g @\($scope)/deveco-code@\($channel)"}},
            {tag: "hr"},
            {tag: "div", text: {tag: "lark_md", content: "**npm 包列表**:\n\($packages)"}},
            {tag: "hr"},
            {tag: "div", text: {tag: "lark_md", content: "**GitCode Release**: [\($tag)](\($release_url))"}},
            {tag: "action", actions: [
              {tag: "button", text: {tag: "plain_text", content: "📦 npm"}, url: $npm_url, type: "primary"},
              {tag: "button", text: {tag: "plain_text", content: "🚀 GitCode"}, url: $release_url, type: "default"}
            ]}
          ]
        }
      }')

    send_card "$PAYLOAD"

    write_summary "## 飞书通知"
    write_summary ""
    write_summary "| 项目 | 值 |"
    write_summary "|------|------|"
    write_summary "| 出包时间 | $BUILD_TIME |"
    write_summary "| 状态 | ✅ 已发送 |"
    write_summary ""
    write_summary "### 安装命令"
    write_summary ""
    write_summary '```bash'
    write_summary "npm i -g @${SCOPE}/deveco-code@${CHANNEL}"
    write_summary '```'
    ;;

  custom)
    TITLE=$(echo "$DATA" | jq -r '.title')
    CONTENT=$(echo "$DATA" | jq -r '.content')
    TEMPLATE=$(echo "$DATA" | jq -r '.template // "green"')

    PAYLOAD=$(jq -n \
      --arg title "$TITLE" \
      --arg content "$CONTENT" \
      --arg template "$TEMPLATE" \
      '{
        msg_type: "interactive",
        card: {
          header: {
            title: {tag: "plain_text", content: $title},
            template: $template
          },
          elements: [
            {tag: "div", text: {tag: "lark_md", content: $content}}
          ]
        }
      }')

    send_card "$PAYLOAD"
    ;;

  *)
    show_help
    exit 1
    ;;
esac
