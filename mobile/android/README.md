# PaperDock 安卓工作台

本分支使用[共用手机工作台](../workbench/README.md)。先在仓库根目录运行 `npm ci` 和 `npm run build:mobile`，再进入本目录准备模型及构建 APK。

面向 Android 9 及以上。通过系统文件选择器导入和保存文档。文字识别支持本机识别中英文、校对和导出 TXT、Word、Excel。页面整理、批注和格式转换等工具见[手机工作台说明](../workbench/README.md)。APK 不申请联网权限，构建时内置识别模型。

预览版一次可导入最多 10 张图片，或最多 20 页、50 MB 的 PDF。PDF 识别逐页渲染后调用 OCR。手写公式、图表和复杂排版仍需核对。

## 构建

准备 JDK 17、Gradle 8.9、Android SDK Platform 34 和 Build Tools 34.0.0，设置 `JAVA_HOME` 和 `ANDROID_HOME`。用 Python 3.9 或更新版本下载并校验官方模型，然后构建预览包。

```text
python prepare_models.py
gradle :app:assembleDebug
```

生成 `app/build/outputs/apk/debug/app-debug.apk`。这是调试签名预览包。测试可在已经授权的设备或模拟器上运行 `gradle :app:connectedDebugAndroidTest`，用自制中英文图片核对图像识别、图片转 PDF 和扫描 PDF 识别。公开源码不包含模型、签名密钥、APK 或测试原件。

只需要给 64 位 ARM 手机安装时，可用 `gradle :app:assembleDebug -PpaperdockAbi=arm64-v8a` 缩小安装包。默认构建保留各平台 ABI，适用于模拟器测试。

## 第三方组件

- `vendor/ppocr-sdk` 采用 [PaddleOCR 安卓 SDK](https://github.com/PaddlePaddle/PaddleOCR/tree/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/deploy/ppocr-android/ppocr-sdk) 的固定源码，保留 [Apache-2.0](vendor/ppocr-sdk/LICENSE) 和源文件版权声明。此处 Gradle 配置为 PaperDock 独立构建而编写。
- [PP-OCRv6_tiny_det](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det) 与 [PP-OCRv6_tiny_rec](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec) 的模型卡列出 Apache-2.0。下载脚本使用 [官方端侧部署说明](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/cross_platform/android_deployment.html) 中的 ONNX 档案及固定校验值。
- [ONNX Runtime](https://github.com/microsoft/onnxruntime) 采用 MIT。[OpenCV 4.12.0 官方 Android 包](https://central.sonatype.com/artifact/org.opencv/opencv/4.12.0)和 Kotlin 协程采用 Apache-2.0。
