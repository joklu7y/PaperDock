$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$logRoot = Join-Path $projectRoot 'runtime-logs'
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
New-Item -ItemType Directory -Force -Path $logRoot, 'C:\Users\ROG\.cache\paddle\dataset' | Out-Null

function Get-LocalListenerPid([int]$port) {
  $line = netstat -ano -p tcp | Select-String -Pattern "127.0.0.1:$port\s+.*LISTENING" | Select-Object -First 1
  if (-not $line) { return $null }
  $fields = ($line.ToString().Trim() -split '\s+')
  return [int]$fields[-1]
}

$pidFile = Join-Path $logRoot 'watchdog.pid'
$watchdogPath = Join-Path $projectRoot 'watchdog.ps1'
$watchdogRunning = $false
$watchdogProcess = $null
if (Test-Path $pidFile) {
  $savedPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($savedPid -match '^\d+$' -and ($watchdogProcess = Get-Process -Id $savedPid -ErrorAction SilentlyContinue)) {
    $watchdogRunning = $true
  }
}

$webRunning = [bool](Get-LocalListenerPid 3000)
$apiPid = Get-LocalListenerPid 8001
$apiRunning = [bool]$apiPid

# Always replace the watchdog when this launcher is run. This makes updated
# backend settings take effect instead of leaving an older hidden watcher alive.
if ($watchdogRunning) {
  Stop-Process -Id $watchdogProcess.Id -Force
  Start-Sleep -Milliseconds 300
}
if ($apiRunning) {
  Stop-Process -Id $apiPid -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
$watchdog = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watchdogPath -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $watchdog.Id -Encoding ascii

for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  if ((Get-LocalListenerPid 3000) -and (Get-LocalListenerPid 8001)) {
    Write-Host 'PaperDock started at http://127.0.0.1:3000'
    exit 0
  }
}

Write-Error "Start failed. Check $logRoot\web.log and $logRoot\api.log"
