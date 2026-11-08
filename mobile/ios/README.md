# PaperDock iOS 预览源码

本分支使用[共用手机工作台](../workbench/README.md)。先在仓库根目录运行 `npm ci` 和 `npm run build:mobile`，再使用 Xcode 编译 iOS。

面向 iOS 16 及以上的 SwiftUI 工程。首版使用 Vision、PDFKit 和系统文件选择器处理图片与 PDF，支持本机 OCR、手工校对、TXT 保存及图片转 PDF。PDF 有文字层时直接读取。

在 macOS 上使用 Xcode 打开 `PaperDockMobile.xcodeproj`，选择 iPhone 模拟器运行。也可以先进行不签名编译。

```sh
xcodebuild -project PaperDockMobile.xcodeproj -target PaperDockMobile \
  -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

在 Xcode 选择 `PaperDockMobile` 方案和 iPhone 模拟器后，使用 Product → Test。测试在本机生成印刷体样张，检查图片识别、文字版 PDF 提取，以及两张图片合成 PDF 后的逐页识别。

真机安装需要在 Xcode 选择开发团队和签名，分发还需要相应的 Apple 发布流程。本文目录提供预览源码。编译和真机结论以实际测试记录为准。
