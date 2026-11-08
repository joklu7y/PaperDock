# PaperDock 手机工作台开发分支

Android 与 iOS 打包同一套 PaperDock 界面。手机尺寸使用抽屉导航、单列工具卡、独立的搜索行和适合触控的页面工具。Android 的文件选择、保存、截图导入和 OCR 由系统及 PaddleOCR 提供，iOS 对应功能使用系统文件选择器和 Vision。PDF 处理引擎随包携带。

```text
npm ci
npm run build:mobile
npm run test:mobile-pdf
```

网页资源输出到 `mobile/workbench-dist/`。构建 Android 或 iOS 之前先生成这些资源。安卓仍使用 `prepare_models.py` 下载和核对模型。iOS 可先在 Xcode 模拟器验证；在 iPhone 安装还需要开发签名。

本分支是功能完整性验证期间的开发版本。文档对比、表格识别、复杂版面重建和视频壁纸仍需逐项完成或验证。原始样张、密钥、APK、模型以及生成的网页资源不提交到 Git。

离线处理使用 [MuPDF.js 1.28.1](https://www.npmjs.com/package/mupdf/v/1.28.1)，采用 AGPL-3.0-or-later。压缩和导出使用 [fflate](https://github.com/101arrowz/fflate)、[docx](https://github.com/dolanmiu/docx)及[PptxGenJS](https://github.com/gitbrent/PptxGenJS)，均采用 MIT。Android 和 iOS 原有 OCR 许可说明见各自目录。
