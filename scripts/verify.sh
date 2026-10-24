#!/usr/bin/env bash
# 本地验证入口：类型检查 + 全量单测。
#
# 用法：
#   bash scripts/verify.sh
#   bash scripts/verify.sh src/memory-index.test.ts   # 只跑指定测试
set -euo pipefail

cd "$(dirname "$0")/.."

# WSL 里的 node 可能太旧；在 Windows 工作区可传 NODE_BIN=... 指定新版 Node。
NODE_BIN="${NODE_BIN:-node}"

echo "[verify] tsc --noEmit"
"$NODE_BIN" node_modules/typescript/bin/tsc --noEmit

echo "[verify] vitest"
if [ "$#" -gt 0 ]; then
  "$NODE_BIN" node_modules/vitest/vitest.mjs run "$@"
else
  "$NODE_BIN" node_modules/vitest/vitest.mjs run
fi
