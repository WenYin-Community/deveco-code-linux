#!/bin/bash
# ensure-jq.sh — 确保 jq 可用
#
# K8s 自托管镜像不保证预装 jq，缺失时用华为云 apt 源补装，避免 PR 自动化
# （/merge、/recheck、指南评论）因缺少 gitcode-api.sh 的解析工具而失败。

set -euo pipefail

if command -v jq >/dev/null; then
  jq --version
  exit 0
fi

SUDO=()
if [ "$(id -u)" -ne 0 ]; then
  SUDO=(sudo)
fi

for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
  [ -f "$f" ] || continue
  "${SUDO[@]}" sed -i -E \
    's#https?://(archive|security)\.ubuntu\.com/ubuntu#https://mirrors.huaweicloud.com/ubuntu#g' "$f"
done

"${SUDO[@]}" apt-get update -qq
"${SUDO[@]}" apt-get install -y -qq jq
jq --version
