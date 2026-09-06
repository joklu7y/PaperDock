$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot
$env:PADDLE_PDX_CACHE_HOME = Join-Path $projectRoot 'runtime-cache\paddlex'
$env:PADDLE_PDX_MODEL_SOURCE = 'bos'
$env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK = 'true'
$env:FLAGS_enable_pir_api = '0'
$env:FLAGS_enable_pir_in_executor = '0'

npm run build:desktop

& .\.venv\Scripts\python.exe -m PyInstaller `
  --noconfirm `
  --clean `
  --windowed `
  --onedir `
  --distpath desktop-release `
  --name PaperDock `
  --add-data "desktop-dist;desktop-dist" `
  --add-data "runtime-cache\paddlex;runtime-cache\paddlex" `
  --hidden-import backend.app `
  --collect-all paddle `
  --collect-all paddleocr `
  --collect-all paddlex `
  --collect-submodules paddlex.inference `
  --collect-submodules paddleocr `
  --collect-all imagesize `
  --collect-all pyclipper `
  --collect-all pypdfium2 `
  --collect-all bidi `
  --collect-all shapely `
  --copy-metadata imagesize `
  --copy-metadata pyclipper `
  --copy-metadata pypdfium2 `
  --copy-metadata python-bidi `
  --copy-metadata shapely `
  --collect-all cv2 `
  --collect-all fitz `
  --collect-all imageio_ffmpeg `
  desktop_app.py

Write-Host "Desktop package created: $projectRoot\desktop-release\PaperDock\PaperDock.exe"
