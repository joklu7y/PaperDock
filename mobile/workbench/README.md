# PaperDock 手机工作台开发分支

Android 与 iOS 打包同一套 PaperDock 界面。手机尺寸使用抽屉导航、响应式工具卡、独立的搜索行和适合触控的页面工具。Android 的文件选择、保存、截图导入和 OCR 由系统及 PaddleOCR 提供，iOS 对应功能使用系统文件选择器和 Vision。PDF 处理引擎随包携带。

```text
npm ci
npm run build:mobile
npm run test:mobile-pdf
```

网页资源输出到 `mobile/workbench-dist/`。构建 Android 或 iOS 之前先生成这些资源。安卓仍使用 `prepare_models.py` 下载和核对模型。iOS 可先在 Xcode 模拟器验证；在 iPhone 安装还需要开发签名。

本分支提供开发阶段的手机工作台。页面整理、安全与修复、批注签名、表单、文档比较、表格和版面、格式导出及外观均有本地实现。复杂表格与版面仍需用不同来源样张校对；桌面的截图入口在手机上改为导入系统截图。各平台可处理的视频格式以设备解码器为准，移动端视频限制为 50 MB、5 分钟。原始样张、密钥、APK、模型以及生成的网页资源不提交到 Git。

离线处理使用 [MuPDF.js 1.28.1](https://www.npmjs.com/package/mupdf/v/1.28.1)，采用 AGPL-3.0-or-later。压缩和导出使用 [fflate](https://github.com/101arrowz/fflate)、[docx](https://github.com/dolanmiu/docx)及 [PptxGenJS](https://github.com/gitbrent/PptxGenJS)，均采用 MIT。文本对比使用 [jsdiff](https://github.com/kpdecker/jsdiff)。Android 视频处理使用采用 Apache-2.0 的 [AndroidX Media3](https://github.com/androidx/media)。Android 和 iOS 原有 OCR 许可说明见各自目录。
