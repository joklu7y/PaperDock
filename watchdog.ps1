$ErrorActionPreference = 'Continue'

# Keeps the local web page and OCR service available after sleep or an unexpected exit.
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$logRoot = Join-Path $projectRoot 'runtime-logs'
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
New-Item -ItemType Directory -Force -Path $logRoot, (Join-Path $projectRoot 'runtime-cache') | Out-Null

function Write-WatchdogLog([string]$message) {
  Add-Content -Path (Join-Path $logRoot 'watchdog.log') -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $message" -Encoding utf8
}

function Get-LocalListenerPid([int]$port) {
  $line = netstat -ano -p tcp | Select-String -Pattern "127.0.0.1:$port\s+.*LISTENING" | Select-Object -First 1
  if (-not $line) { return $null }
  $fields = ($line.ToString().Trim() -split '\s+')
  return [int]$fields[-1]
}

# The locally bundled production runner needs protected Windows profile folders
# on some PCs, so the local launcher uses Vinext directly.  Explicit host/port
# arguments avoid its automatic-port fallback after a wake-up.
$webCommand = "cd /d `"$projectRoot`" && npm run dev -- --host 127.0.0.1 --port 3000 > `"$logRoot\web.log`" 2>&1"
$lastBackendStart = [DateTime]::MinValue
$lastWebStart = [DateTime]::MinValue

while ($true) {
  if (-not (Get-LocalListenerPid 8001) -and ((Get-Date) - $lastBackendStart).TotalSeconds -ge 20) {
    $backend = Start-Process -FilePath $python -WorkingDirectory $projectRoot -ArgumentList '-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', '8001' -WindowStyle Hidden -PassThru
    $lastBackendStart = Get-Date
    Write-WatchdogLog "Started backend process $($backend.Id)."
  }
  if (-not (Get-LocalListenerPid 3000) -and ((Get-Date) - $lastWebStart).TotalSeconds -ge 20) {
    $web = Start-Process cmd.exe -ArgumentList '/d', '/c', $webCommand -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    $lastWebStart = Get-Date
    Write-WatchdogLog "Started web process $($web.Id)."
  }
  Start-Sleep -Seconds 10
}
