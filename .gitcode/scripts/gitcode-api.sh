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
  create-issue <title>             Create an issue (body from stdin)
  update-issue <number> [title]    Update an issue/PR (body from stdin)
  update-pr <number> [title]       Update a PR (body from stdin)
  create-pr <title> <head> <base>  Create a PR (body from stdin)
  post-comment <number>           Post a comment (body from stdin)
  delete-comment <comment_id>      Delete a comment
  add-label <number> <label>       Add a label
  remove-label <number> <label>    Remove a label
  close-issue <number>            Close an issue or PR
  reopen-issue <number>           Reopen an issue or PR
  get-issue <number>              Get details (JSON)
  list-comments <number>           List comments (JSON)
  list-linked-issues <number>     List issues linked to a PR (JSON)
  list-prs [state] [head] [base]  List pull requests (JSON)
  merge-pr <number> [method]      Merge a PR (ff/rebase/squash, default: ff)
  assign-tester <number> <user>  Assign a tester to a PR
  approve-test <number> [state]  Submit test result (passed/failed)
  reset-test <number>            Reset test approval (revoke tester accept)
  check-ci <number>              Check Test/Typecheck CI status (OK or failures)
  rerun-failed <number>          Re-dispatch failed workflows for a PR

Examples:
  echo "Please fix the title" | bash gitcode-api.sh post-comment 653
  bash gitcode-api.sh add-label 653 waiting_on_author
  echo "Issue body" | bash gitcode-api.sh create-issue "Bug title"
  echo "PR body" | bash gitcode-api.sh create-pr "PR title" feature develop
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
  create-issue)
    TITLE="$1"
    BODY=$(cat)
    curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$(jq -n --arg title "$TITLE" --arg body "$BODY" '{title:$title,body:$body}')" \
      "$API/repos/$REPO/issues"
    ;;
  update-issue)
    NUMBER="$1"
    TITLE="${2:-}"
    BODY=$(cat)
    PAYLOAD="{}"
    [ -n "$TITLE" ] && PAYLOAD=$(echo "$PAYLOAD" | jq --arg t "$TITLE" '. + {title:$t}')
    [ -n "$BODY" ] && PAYLOAD=$(echo "$PAYLOAD" | jq --arg b "$BODY" '. + {body:$b}')
    curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$PAYLOAD" \
      "$API/repos/$REPO/$TYPE/$NUMBER"
    ;;
  update-pr)
    NUMBER="$1"
    TITLE="${2:-}"
    BODY=$(cat)
    PAYLOAD="{}"
    [ -n "$TITLE" ] && PAYLOAD=$(echo "$PAYLOAD" | jq --arg t "$TITLE" '. + {title:$t}')
    [ -n "$BODY" ] && PAYLOAD=$(echo "$PAYLOAD" | jq --arg b "$BODY" '. + {body:$b}')
    curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$PAYLOAD" \
      "$API/repos/$REPO/pulls/$NUMBER"
    ;;
  create-pr)
    TITLE="$1"
    HEAD="$2"
    BASE="$3"
    BODY=$(cat)
    curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$(jq -n --arg title "$TITLE" --arg head "$HEAD" --arg base "$BASE" --arg body "$BODY" '{title:$title,head:$head,base:$base,body:$body}')" \
      "$API/repos/$REPO/pulls"
    ;;
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
    curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/$TYPE/$NUMBER" \
      | tr -d '\000-\010\013\014\016-\037'
    ;;
  list-comments)
    NUMBER="$1"
    curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/$TYPE/$NUMBER/comments"
    ;;
  list-linked-issues)
    NUMBER="$1"
    curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/pulls/$NUMBER/issues"
    ;;
  list-prs)
    STATE="${1:-open}"
    HEAD="${2:-}"
    BASE="${3:-}"
    QUERY="state=${STATE}"
    [ -n "$HEAD" ] && QUERY="${QUERY}&head=${HEAD}"
    [ -n "$BASE" ] && QUERY="${QUERY}&base=${BASE}"
    curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/pulls?${QUERY}"
    ;;
  merge-pr)
    NUMBER="$1"
    METHOD="${2:-ff}"
    curl -sS -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "{\"merge_method\":\"$METHOD\"}" \
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
  reset-test)
    NUMBER="$1"
    curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" \
      "$API/repos/$REPO/pulls/$NUMBER/testers"
    ;;
  check-ci)
    NUMBER="$1"
    PR_DATA=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/pulls/$NUMBER")
    HEAD_SHA=$(echo "$PR_DATA" | python3 -c "
import json,sys,re
raw = sys.stdin.read()
clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', raw)
d = json.loads(clean)
print(d.get('head',{}).get('sha',''))
" 2>/dev/null)
    if [ -z "$HEAD_SHA" ]; then
      echo "CI 检查失败"
      exit 1
    fi
    ACTIONS_API="${API%/v5}/v8"
    curl -sS -H "Authorization: Bearer $TOKEN" \
      "$ACTIONS_API/repos/$REPO/actions/runs?per_page=100" 2>/dev/null \
      | python3 -c "
import json,sys
data = json.load(sys.stdin)
runs = data.get('workflow_runs', [])
sha = '$HEAD_SHA'
result = []
for name in ['Test', 'Typecheck']:
    matching = [r for r in runs if r.get('workflow_name') == name and r.get('head_sha') == sha]
    if not matching:
        result.append(f'{name} CI 未运行')
    else:
        status = matching[0].get('status', '')
        if status == 'COMPLETED':
            pass
        elif status == 'RUNNING':
            result.append(f'{name} CI 运行中')
        else:
            result.append(f'{name} CI {status}')
if result:
    print(';'.join(result))
else:
    print('OK')
" 2>/dev/null
    ;;
  rerun-failed)
    NUMBER="$1"
    PR_DATA=$(bash "$0" get-issue "$NUMBER")
    HEAD_SHA=$(echo "$PR_DATA" | jq -r '.head.sha // ""')
    HEAD_BRANCH=$(echo "$PR_DATA" | jq -r '.head.ref // ""')
    if [ -z "$HEAD_SHA" ] || [ -z "$HEAD_BRANCH" ]; then
      echo "Failed to get PR #$NUMBER head info" >&2
      exit 1
    fi
    ACTIONS_API="${API%/v5}/v8"
    FAILED=$(curl -sS -H "Authorization: Bearer $TOKEN" \
      "$ACTIONS_API/repos/$REPO/actions/runs?per_page=100" 2>/dev/null \
      | python3 -c "
import json,sys
data = json.load(sys.stdin)
runs = data.get('workflow_runs', [])
sha = '$HEAD_SHA'
skip = {'PR Standards', 'Auto Merge', 'Compliance Close', 'Issue Check', 'Publish', 'Publish Tag'}
seen = set()
for r in runs:
    if r.get('head_sha') == sha and r.get('status') in ('FAILED', 'CANCELED'):
        name = r.get('workflow_name', '')
        wf_id = r.get('workflow_id', '')
        if name not in skip and wf_id not in seen:
            seen.add(wf_id)
            print(f'{wf_id}|{name}')
" 2>/dev/null)
    if [ -z "$FAILED" ]; then
      echo "No failed workflows to re-run for PR #$NUMBER"
    else
      echo "$FAILED" | while IFS='|' read -r WF_ID WF_NAME; do
        curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
          -d "{\"ref\":\"$HEAD_BRANCH\"}" \
          "$ACTIONS_API/repos/$REPO/actions/workflows/$WF_ID/dispatches" 2>/dev/null
        echo "Re-triggered: $WF_NAME"
      done
    fi
    ;;
  *)
    show_help
    exit 1
    ;;
esac
