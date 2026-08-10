#!/bin/bash
# gitcode-api.sh — GitCode Issue/PR API wrapper
# Set GITCODE_TYPE=pulls for PR operations (default: issues)

show_help() {
  cat <<'HELP'
gitcode-api.sh — GitCode Issue/PR API wrapper

Usage: bash gitcode-api.sh <command> [args]

Environment:
  GITCODE_TYPE=issues (default) or pulls — selects API endpoint

Commands:
  post-comment <number>           Post a comment (body from stdin)
  delete-comment <comment_id>      Delete a comment
  add-label <number> <label>       Add a label
  remove-label <number> <label>    Remove a label
  close-issue <number>            Close an issue or PR
  reopen-issue <number>           Reopen an issue or PR
  get-issue <number>              Get details (JSON)
  list-comments <number>           List comments (JSON)
  list-linked-issues <number>     List issues linked to a PR (JSON)
  merge-pr <number>               Merge a PR
  assign-tester <number> <user>  Assign a tester to a PR
  approve-test <number> [state]  Submit test result (passed/failed)

Examples:
  echo "Please fix the title" | bash gitcode-api.sh post-comment 653
  bash gitcode-api.sh add-label 653 waiting_on_author
  GITCODE_TYPE=pulls bash gitcode-api.sh post-comment 677
HELP
}

CMD="${1:-}"
if [ "$CMD" = "-h" ] || [ "$CMD" = "--help" ] || [ "$CMD" = "help" ]; then
  show_help
  exit 0
fi

set -euo pipefail

API="${GITCODE_API:?GITCODE_API not set}"
REPO="${GITCODE_REPO:?GITCODE_REPO not set}"
TOKEN="${GITCODE_TOKEN:?GITCODE_TOKEN not set}"
TYPE="${GITCODE_TYPE:-issues}"

shift || true

case "$CMD" in
  post-comment)
    NUMBER="$1"
    BODY=$(cat)
    curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$(jq -n --arg body "$BODY" '{body: $body}')" \
      "$API/repos/$REPO/$TYPE/$NUMBER/comments"
    ;;
  delete-comment)
    COMMENT_ID="$1"
    curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
      "$API/repos/$REPO/$TYPE/comments/$COMMENT_ID"
    ;;
  add-label)
    NUMBER="$1"
    LABEL="$2"
    curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$(jq -n --arg label "$LABEL" '[$label]')" \
      "$API/repos/$REPO/$TYPE/$NUMBER/labels"
    ;;
  remove-label)
    NUMBER="$1"
    LABEL="$2"
    curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
      "$API/repos/$REPO/$TYPE/$NUMBER/labels/$LABEL"
    ;;
  close-issue)
    NUMBER="$1"
    if [ "$TYPE" = "pulls" ]; then
      curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d '{"state":"closed"}' \
        "$API/repos/$REPO/$TYPE/$NUMBER"
    else
      TITLE=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/issues/$NUMBER" | jq -r '.title')
      curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d "$(jq -n --arg t "$TITLE" '{state:"close",title:$t}')" \
        "$API/repos/$REPO/issues/$NUMBER"
    fi
    ;;
  reopen-issue)
    NUMBER="$1"
    if [ "$TYPE" = "pulls" ]; then
      curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d '{"state":"open"}' \
        "$API/repos/$REPO/$TYPE/$NUMBER"
    else
      TITLE=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/issues/$NUMBER" | jq -r '.title')
      curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d "$(jq -n --arg t "$TITLE" '{state:"reopen",title:$t}')" \
        "$API/repos/$REPO/issues/$NUMBER"
    fi
    ;;
  get-issue)
    NUMBER="$1"
    curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/$TYPE/$NUMBER"
    ;;
  list-comments)
    NUMBER="$1"
    curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/$TYPE/$NUMBER/comments"
    ;;
  list-linked-issues)
    NUMBER="$1"
    curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/pulls/$NUMBER/issues"
    ;;
  merge-pr)
    NUMBER="$1"
    curl -sS -X PUT -H "Authorization: Bearer $TOKEN" \
      "$API/repos/$REPO/pulls/$NUMBER/merge"
    ;;
  assign-tester)
    NUMBER="$1"
    TESTER="$2"
    curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "{\"testers\":[\"$TESTER\"]}" \
      "$API/repos/$REPO/pulls/$NUMBER/testers"
    ;;
  approve-test)
    NUMBER="$1"
    STATE="${2:-passed}"
    curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "{\"test_state\":\"$STATE\"}" \
      "$API/repos/$REPO/pulls/$NUMBER/test"
    ;;
  *)
    show_help
    exit 1
    ;;
esac
