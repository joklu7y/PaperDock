# PaperDock

PaperDock 是 Windows 上的本地文档工具，可以整理 PDF、识别图片和扫描件，并导出文字、Office 文件和图片。文档处理在本机运行。首次启用 OCR 时可能需要联网下载模型，缓存准备好后可以离线识别。

## 功能

- 合并、拆分、重排、旋转、裁切、加水印，以及提取 PDF 页面和内嵌图片。
- PDF 批注、图章签名、表单填写、加解密、文字层涂黑和损坏文件修复。
- 图片与扫描件 OCR。扫描 PDF 转 TXT 和逐行文字 Excel 时按页识别，有可用文字层的页面直接提取。
- 截图转 PDF、文档对比，以及 Word、PPT、Markdown、ODT、EPUB 等格式导出。

手写公式、图表和复杂版面可能识别不完整，导出后请核对。Excel 的逐行文字与表格识别是不同入口。

## 从源码运行

使用 Windows、64 位 Python 3.11 和 Node.js 22.13 或更新版本。在项目根目录的 PowerShell 中运行。

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-windows.txt
npm ci
npm run build:desktop
.\.venv\Scripts\python.exe .\desktop_app.py
```

桌面启动器会在本机启动处理服务。首次安装 Python 和 npm 依赖需要联网。开发时也可以分别运行 `python -m uvicorn backend.app:app --host 127.0.0.1 --port 8001` 和 `npm run dev`，在浏览器打开 `http://127.0.0.1:3000/desktop/`。

## 测试与打包

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
npm run test:ocr-render
.\.venv\Scripts\python.exe .\scripts\test-tools.py
.\.venv\Scripts\python.exe .\scripts\test-tools.py --ocr
.\build-desktop.ps1
```

`--ocr` 测试包含端到端识别，首次运行可能下载模型。Windows 可执行文件位于 `desktop-release/PaperDock/`。可用 Inno Setup 6 和 `build-installer.ps1` 构建安装程序。默认构建不要求预先下载模型。分发安装包前请核对第三方组件和模型许可，并提供对应源码。

## 许可证

PaperDock 的项目代码采用 [AGPL-3.0](LICENSE)。依赖和第三方组件各自遵循原有许可。查看 [第三方组件与分发说明](THIRD_PARTY_NOTICES.md)。
