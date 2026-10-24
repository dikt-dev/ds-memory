#!/usr/bin/env bash
# 本地验证入口：类型检查 + 全量单测。
#
# 用法：
#   bash scripts/verify.sh
#   bash scripts/verify.sh src/memory-index.test.ts   # 只跑指定测试
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[verify] tsc --noEmit"
node node_modules/typescript/bin/tsc --noEmit

echo "[verify] vitest"
if [ "$#" -gt 0 ]; then
  node node_modules/vitest/vitest.mjs run "$@"
else
  node node_modules/vitest/vitest.mjs run
fi
