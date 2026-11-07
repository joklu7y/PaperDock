# 第三方组件与分发说明

PaperDock 自有代码采用 AGPL-3.0。下列主要组件保留各自的许可证；安装依赖所附许可证及上游仓库为准。源码仓库不包含 OCR 权重、安装包、第三方二进制、个人资料或测试文档。

| 组件 | 上游与说明 |
|---|---|
| PyMuPDF / MuPDF | [官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html)，上游提供 AGPL 和商业许可。该项目采用 AGPL 路线。 |
| PaddleOCR / PaddlePaddle / PaddleX | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、[PaddlePaddle](https://github.com/PaddlePaddle/Paddle)、[PaddleX](https://github.com/PaddlePaddle/PaddleX)，Apache-2.0。模型权重分发以各模型来源的许可为准。 |
| shadcn/ui | [shadcn/ui](https://github.com/shadcn-ui/ui)，部分组件由其模板生成，保留 [MIT 文本](licenses/shadcn-ui.txt)。 |
| Roboto | [Roboto](https://github.com/googlefonts/roboto)，通过 Fontsource 安装。分发时保留所用版本的字体许可。 |
| FFmpeg | [FFmpeg 法律与许可说明](https://ffmpeg.org/legal.html)。Windows 构建可能通过 imageio-ffmpeg 收录 FFmpeg，许可和源码义务取决于实际二进制构建选项。 |

所有直接 Python 依赖见 `backend/requirements-windows.txt`，前端依赖和解析结果见 `package.json` 与 `package-lock.json`。

发布 Windows 安装包前，按实际打包清单核对依赖许可证、对应源码及通知文件，并核对随包模型权重的分发权限。保留能构建同一版本的项目源码与构建脚本。

参考 [AGPL-3.0 第 6 节](https://www.gnu.org/licenses/agpl-3.0.html#section6)。
