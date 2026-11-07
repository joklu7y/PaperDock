$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  throw '请按 README 创建 .venv 并安装 Python 依赖。'
}
if (-not (Test-Path -LiteralPath 'desktop-dist\index.html')) {
  npm.cmd run build:desktop
  if ($LASTEXITCODE -ne 0) { throw '界面构建失败。请先运行 npm ci。' }
}
& $python .\desktop_app.py
exit $LASTEXITCODE
