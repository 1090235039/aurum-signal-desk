$ErrorActionPreference = "Stop"

$localNode = "node"
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (-not $env:PRODUCT_ID) {
  $env:PRODUCT_ID = "gold-trend-desk"
}

if (-not $env:LICENSE_REQUIRED) {
  $env:LICENSE_REQUIRED = "false"
}

if (Get-Command $localNode -ErrorAction SilentlyContinue) {
  & $localNode "$PSScriptRoot\server.js"
  exit $LASTEXITCODE
}

if (Test-Path $bundledNode) {
  & $bundledNode "$PSScriptRoot\server.js"
  exit $LASTEXITCODE
}

throw "Node.js was not found. Install Node.js or run this script inside the Codex runtime."
