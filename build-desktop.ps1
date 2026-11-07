$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  throw '请按 README 创建 .venv 并安装 Python 构建依赖。'
}

npm.cmd run build:desktop
if ($LASTEXITCODE -ne 0) { throw '界面构建失败。' }

& $python -m PyInstaller --noconfirm --clean --distpath desktop-release .\PaperDock.spec
if ($LASTEXITCODE -ne 0) { throw '桌面打包失败。' }
Write-Host '已生成 desktop-release\PaperDock\PaperDock.exe'
