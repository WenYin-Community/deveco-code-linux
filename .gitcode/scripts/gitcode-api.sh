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
  list-comments <number>           List comments (JSON, paginated)
  list-linked-issues <number>     List issues linked to a PR (JSON)
  list-issues [state]             List issues (JSON, paginated)
  list-prs [state] [head] [base]  List pull requests (JSON)
  merge-pr <number> [method]      Merge a PR (ff/rebase/squash, default: ff), exits 1 on API failure
  assign-tester <number> <user>  Assign a tester to a PR
  approve-test <number> [state]  Submit test result (passed/failed)
  reset-test <number>            Reset test approval (revoke tester accept)
  check-ci <number>              Check Test/Typecheck CI status (OK or failures)
  rerun-failed <number>          Re-dispatch failed CI workflows (Test/Typecheck/Build only)

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
      | tr -d '\000-\010\013-\037'
    ;;
  list-comments)
    NUMBER="$1"
    PAGE=1
    PER_PAGE=100
    RESULTS="[]"
    while true; do
      PAGE_JSON=$(curl -sS -H "Authorization: Bearer $TOKEN" \
        "$API/repos/$REPO/$TYPE/$NUMBER/comments?page=${PAGE}&per_page=${PER_PAGE}")
      PAGE_COUNT=$(printf '%s' "$PAGE_JSON" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(d, list):
    sys.exit(1)
print(len(d))
") || { echo "list-comments: unexpected API response on page $PAGE: $(printf '%s' "$PAGE_JSON" | head -c 200)" >&2; exit 1; }
      if [ "$PAGE_COUNT" -eq 0 ]; then break; fi
      RESULTS=$(python3 -c "
import json, sys
a = json.loads(sys.argv[1], strict=False)
b = json.loads(sys.stdin.read(), strict=False)
print(json.dumps(a + b, ensure_ascii=False))
" "$RESULTS" <<< "$PAGE_JSON")
      if [ "$PAGE_COUNT" -lt "$PER_PAGE" ]; then break; fi
      PAGE=$((PAGE + 1))
    done
    printf '%s' "$RESULTS"
    ;;
  list-linked-issues)
    NUMBER="$1"
    curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/pulls/$NUMBER/issues"
    ;;
  list-issues)
    STATE="${1:-open}"
    PAGE=1
    PER_PAGE=100
    RESULTS="[]"
    while true; do
      PAGE_JSON=$(curl -sS -H "Authorization: Bearer $TOKEN" \
        "$API/repos/$REPO/issues?state=${STATE}&page=${PAGE}&per_page=${PER_PAGE}")
      PAGE_COUNT=$(printf '%s' "$PAGE_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
      if [ "$PAGE_COUNT" -eq 0 ]; then break; fi
      RESULTS=$(python3 -c "
import json, sys
a = json.loads(sys.argv[1])
b = json.loads(sys.stdin.read())
print(json.dumps(a + b))
" "$RESULTS" <<< "$PAGE_JSON")
      if [ "$PAGE_COUNT" -lt "$PER_PAGE" ]; then break; fi
      PAGE=$((PAGE + 1))
    done
    printf '%s' "$RESULTS" | python3 -c "
import json,sys
d = json.loads(sys.stdin.read(), strict=False)
print(json.dumps(d, ensure_ascii=False))
"
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
    RESPONSE=$(curl -sS -w '\n%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "{\"merge_method\":\"$METHOD\"}" \
      "$API/repos/$REPO/pulls/$NUMBER/merge") || exit 1
    HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)
    if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
      echo "$RESPONSE" | sed '$d'
    else
      echo "Merge failed (HTTP $HTTP_CODE): $(echo "$RESPONSE" | sed '$d')" >&2
      exit 1
    fi
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
    HEAD_BRANCH=$(echo "$PR_DATA" | python3 -c "
import json,sys,re
raw = sys.stdin.read()
clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', raw)
d = json.loads(clean)
print(d.get('head',{}).get('ref',''))
" 2>/dev/null)
    if [ -z "$HEAD_SHA" ]; then
      echo "CI 检查失败"
      exit 1
    fi
    CI_STATE=$(echo "$PR_DATA" | python3 -c "
import json,sys,re
raw = sys.stdin.read()
clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', raw)
d = json.loads(clean)
print('1' if d.get('mergeable_state',{}).get('ci_state_passed', False) else '0')
" 2>/dev/null)
    ACTIONS_API="${API%/v5}/v8"
    curl -sS -H "Authorization: Bearer $TOKEN" \
      "$ACTIONS_API/repos/$REPO/actions/runs?per_page=100&branch=$HEAD_BRANCH" 2>/dev/null \
      | python3 -c "
import json,sys
data = json.load(sys.stdin)
runs = data.get('workflow_runs', [])
sha = '$HEAD_SHA'
ci_passed = '$CI_STATE' == '1'
result = []
for name in ['Test', 'Typecheck']:
    matching = [r for r in runs if r.get('workflow_name') == name and r.get('head_sha') == sha]
    if not matching:
        if not ci_passed:
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
    HEAD_SHA=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/pulls/$NUMBER" \
      | python3 -c "
import json,sys,re
raw = sys.stdin.read()
clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', raw)
d = json.loads(clean)
print(d.get('head',{}).get('sha',''))
" 2>/dev/null)
    HEAD_BRANCH=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API/repos/$REPO/pulls/$NUMBER" \
      | python3 -c "
import json,sys,re
raw = sys.stdin.read()
clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', raw)
d = json.loads(clean)
print(d.get('head',{}).get('ref',''))
" 2>/dev/null)
    if [ -z "$HEAD_SHA" ] || [ -z "$HEAD_BRANCH" ]; then
      echo "Failed to get PR #$NUMBER head info" >&2
      exit 1
    fi
    ACTIONS_API="${API%/v5}/v8"
    FAILED=$(curl -sS -H "Authorization: Bearer $TOKEN" \
      "$ACTIONS_API/repos/$REPO/actions/runs?per_page=100&branch=$HEAD_BRANCH" 2>/dev/null \
      | python3 -c "
import json,sys
data = json.load(sys.stdin)
runs = data.get('workflow_runs', [])
sha = '$HEAD_SHA'
# 白名单：只有 CI 类流水线允许被重跑，避免误触发发布、自动合入等有副作用的流程
allow = {'Test', 'Typecheck', 'Build'}
seen = set()
for r in runs:
    if r.get('head_sha') == sha and r.get('status') in ('FAILED', 'CANCELED'):
        name = r.get('workflow_name', '')
        wf_id = r.get('workflow_id', '')
        if name in allow and wf_id not in seen:
            seen.add(wf_id)
            print(f'{wf_id}|{name}')
" 2>/dev/null)
    if [ -z "$FAILED" ]; then
      echo "No failed workflows to re-run for PR #$NUMBER"
    else
      echo "$FAILED" | while IFS='|' read -r WF_ID WF_NAME; do
        # 用 head sha 而不是分支名：fork 仓库的分支名在基础仓库里解析不到，会 404 Not Found Commit
        curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
          -d "{\"ref\":\"$HEAD_SHA\"}" \
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
