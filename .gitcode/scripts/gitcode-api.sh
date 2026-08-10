#!/bin/bash
# gitcode-api.sh — GitCode Issue API wrapper for opencode AI agent

show_help() {
  cat <<'HELP'
gitcode-api.sh — GitCode Issue API wrapper

Usage: bash gitcode-api.sh <command> [args]

Commands:
  post-comment <number>           Post a comment on an issue (body from stdin)
  delete-comment <comment_id>     Delete a comment
  add-label <number> <label>      Add a label to an issue
  remove-label <number> <label>   Remove a label from an issue
  close-issue <number>            Close an issue
  reopen-issue <number>           Reopen an issue
  get-issue <number>              Get issue details (JSON)
  list-comments <number>           List comments on an issue (JSON)

Examples:
  echo "Please fix the title" | bash gitcode-api.sh post-comment 653
  bash gitcode-api.sh add-label 653 waiting_on_author
  bash gitcode-api.sh delete-comment 184062153
  bash gitcode-api.sh remove-label 653 waiting_on_author
  bash gitcode-api.sh close-issue 653
HELP
}

# Handle help before strict mode so it works without env vars
CMD="${1:-}"
if [ "$CMD" = "-h" ] || [ "$CMD" = "--help" ] || [ "$CMD" = "help" ]; then
  show_help
  exit 0
fi

set -euo pipefail

API="${GITCODE_API:?GITCODE_API not set}"
REPO="${GITCODE_REPO:?GITCODE_REPO not set}"
TOKEN="${GITCODE_TOKEN:?GITCODE_TOKEN not set}"

shift || true

case "$CMD" in
  post-comment)
    NUMBER="$1"
    BODY=$(cat)
    curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$(jq -n --arg body "$BODY" '{body: $body}')" \
      "$API/repos/$REPO/issues/$NUMBER/comments"
    ;;
  delete-comment)
    COMMENT_ID="$1"
    curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
      "$API/repos/$REPO/issues/comments/$COMMENT_ID"
    ;;
  add-label)
    NUMBER="$1"
    LABEL="$2"
    curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$(jq -n --arg label "$LABEL" '[$label]')" \
      "$API/repos/$REPO/issues/$NUMBER/labels"
    ;;
  remove-label)
    NUMBER="$1"
    LABEL="$2"
    curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
      "$API/repos/$REPO/issues/$NUMBER/labels/$LABEL"
    ;;
  close-issue)
    NUMBER="$1"
    TITLE=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/issues/$NUMBER" | jq -r '.title')
    curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$(jq -n --arg t "$TITLE" '{state:"close",title:$t}')" \
      "$API/repos/$REPO/issues/$NUMBER"
    ;;
  reopen-issue)
    NUMBER="$1"
    TITLE=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/issues/$NUMBER" | jq -r '.title')
    curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$(jq -n --arg t "$TITLE" '{state:"reopen",title:$t}')" \
      "$API/repos/$REPO/issues/$NUMBER"
    ;;
  get-issue)
    NUMBER="$1"
    curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/issues/$NUMBER"
    ;;
  list-comments)
    NUMBER="$1"
    curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/issues/$NUMBER/comments"
    ;;
  *)
    show_help
    exit 1
    ;;
esac
