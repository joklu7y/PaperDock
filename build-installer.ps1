$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$isccCandidates = @(@(
  $env:PAPERDOCK_ISCC,
  (Join-Path $projectRoot '.tools\Inno Setup 6\ISCC.exe'),
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })

if (-not $isccCandidates) {
  throw '未检测到 Inno Setup 6。请安装 Inno Setup 6 后重新运行此脚本，即可生成带开始菜单、桌面快捷方式和卸载入口的安装包。'
}

$payload = Join-Path $projectRoot 'desktop-release\PaperDock'
if (-not (Test-Path -LiteralPath (Join-Path $payload 'PaperDock.exe') -PathType Leaf)) {
  throw '请先构建 Windows 桌面版，再生成安装包。'
}
foreach ($item in 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses') {
  Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $payload -Recurse -Force
}

& $isccCandidates[0] (Join-Path $projectRoot 'installer\PaperDock.iss')
if ($LASTEXITCODE -ne 0) { throw '安装包构建失败。' }
Write-Host "安装包已生成：$projectRoot\installer-output"
