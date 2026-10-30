<#
.SYNOPSIS
  把线上 D1 灌进本地 wrangler dev，得到一个能复现线上数据的开发环境。

.DESCRIPTION
  目的：任何召回/归档/渲染改动，先在本地跑出结论再上线。
  背景：wrangler tail 在开发者的网络上连不上，线上日志等于没有；
        2026-10-29~31 三次「改了看不见」的翻车都源于此。

  覆盖范围：
    D1      完全一致（messages / memory_* / cron_runs / engine_metrics …）
    R2/KV   是空的 —— memory.md 在 R2 里，所以本地「长期记忆为空」是预期行为，
            不是 bug（完整复现见 docs/runbooks/local-env.md 第 3 节）
    DeepSeek 走 .dev.vars 里的真 key，本地聊天会计费，调试时少发消息

  快照里有真实对话，tmp/ 已进 .gitignore，用完请自行删除。

.PARAMETER Port
  本地端口，默认 8799（避开 wrangler 默认 8787）。

.PARAMETER SkipExport
  复用已有的 tmp/prod-snapshot.sql，不重新导出（省 20~60 秒）。

.EXAMPLE
  ./scripts/local-env.ps1
  ./scripts/local-env.ps1 -SkipExport -Port 8787
#>
param(
  [int]$Port = 8799,
  [switch]$SkipExport
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:CLOUDFLARE_ACCOUNT_ID) {
  $env:CLOUDFLARE_ACCOUNT_ID = '1d0cedf164665fcc2ff558ec4a0564a2'
  Write-Host "使用默认账号 $env:CLOUDFLARE_ACCOUNT_ID"
}

$snapshot = Join-Path $root 'tmp\prod-snapshot.sql'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'tmp') | Out-Null

if (-not $SkipExport) {
  Write-Host '[1/3] 导出线上 D1 ...'
  npx wrangler d1 export ds-memory-db --remote -c wrangler.local.toml --output=$snapshot
  if (-not (Test-Path $snapshot)) { throw '导出失败：没有生成快照文件' }
} else {
  Write-Host "[1/3] 复用已有快照 $snapshot"
}

Write-Host '[2/3] 清空本地 D1 并导入 ...'
$state = Join-Path $root '.wrangler\state'
if (Test-Path $state) { Remove-Item -Recurse -Force $state }
npx wrangler d1 execute ds-memory-db --local -c wrangler.local.toml --file=$snapshot

Write-Host '[3/3] 启动本地 Worker ...'
Write-Host "     http://127.0.0.1:$Port"
Write-Host '     提示：本地 R2/KV 是空的，长期记忆为空属正常（见 docs/runbooks/local-env.md）'
npx wrangler dev -c wrangler.local.toml --port $Port --ip 127.0.0.1