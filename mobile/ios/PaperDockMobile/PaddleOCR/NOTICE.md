# iOS 文字识别的第三方组件

- Swift 识别引擎、图像和多边形桥接代码来自 [PaddleOCR iOS 示例](https://github.com/PaddlePaddle/PaddleOCR/tree/6a8b8f1e32622e2b1e868cca3529e388d5f038c1/deploy/ios_demo)，采用 [Apache-2.0](LICENSE)。PaperDock 使用公开的 ONNX Runtime Swift 接口和 CPU 会话，将返回的文本与坐标接到应用的文档工具中。
- Clipper 6.4.2 源码来自同一示例。它保留 Angus Johnson 的版权声明和 [Boost Software License 1.0](Clipper/LICENSE)。
- [ONNX Runtime Swift 1.24.2](https://github.com/microsoft/onnxruntime-swift-package-manager/tree/1.24.2)和 [Yams 5.0.6](https://github.com/jpsim/Yams/tree/5.0.6)采用 MIT。[OpenCV 4.12.0](https://github.com/opencv/opencv/tree/4.12.0)采用 Apache-2.0，由 [OpenCV Swift Package](https://github.com/yeatse/opencv-spm/tree/4.12.0)提供带校验值的框架。
- [Small 检测权重](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx)和[识别权重](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx)采用 Apache-2.0，构建时由与安卓共用的脚本校验并打包。
