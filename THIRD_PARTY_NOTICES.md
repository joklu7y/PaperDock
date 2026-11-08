# 第三方组件与分发说明

PaperDock 自有代码采用 AGPL-3.0。下列主要组件保留各自的许可证；安装依赖所附许可证及上游仓库为准。源码仓库不包含 OCR 权重、安装包、第三方二进制、个人资料或测试文档。

| 组件 | 上游与说明 |
|---|---|
| PyMuPDF / MuPDF | [官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html)，该项目采用 AGPL。Windows 依赖使用 [PyMuPDF 1.28.2](https://pypi.org/project/PyMuPDF/1.28.2/)，所用 MuPDF 版本为 1.28.2。 |
| PaddleOCR / PaddlePaddle / PaddleX | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、[PaddlePaddle](https://github.com/PaddlePaddle/Paddle)、[PaddleX](https://github.com/PaddlePaddle/PaddleX)，Apache-2.0。模型权重分发以各模型来源的许可为准。 |
| shadcn/ui | [shadcn/ui](https://github.com/shadcn-ui/ui)，部分组件由其模板生成，保留 [MIT 文本](licenses/shadcn-ui.txt)。 |
| Lucide | [Lucide](https://github.com/lucide-icons/lucide) 提供界面图标与手机启动图标使用的 ScanText 图形，保留[许可证文本](licenses/lucide-react.txt)。 |
| Roboto | [Roboto](https://github.com/googlefonts/roboto)，通过 Fontsource 安装。分发时保留所用版本的字体许可。 |
| FFmpeg | Windows x64 版的 `imageio-ffmpeg==0.6.0` 携带 [GyanD FFmpeg 7.1 Essentials](https://github.com/GyanD/codexffmpeg/releases/tag/7.1)，保留 [GPL-3.0 许可](licenses/ffmpeg-7.1-gpl3.txt)，FFmpeg 本体对应[源码提交](https://github.com/FFmpeg/FFmpeg/commit/b08d7969c5)。该发行版静态链接第三方库，分发时也要核对这些库的确切源码和通知。参考 [FFmpeg 法律与许可说明](https://ffmpeg.org/legal.html)。 |

所有直接 Python 依赖见 `backend/requirements-windows.txt`，前端依赖和解析结果见 `package.json` 与 `package-lock.json`。

发布 Windows 安装包前，按实际打包清单核对依赖许可证、对应源码及通知文件，并核对随包模型权重的分发权限。保留能构建同一版本的项目源码与构建脚本。

参考 [AGPL-3.0 第 6 节](https://www.gnu.org/licenses/agpl-3.0.html#section6)。
