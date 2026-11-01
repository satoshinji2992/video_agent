# 第三方资源与许可

本项目自己的代码采用 MIT（`LICENSE`），文档、调研资料和 benchmark 内容采用 CC BY 4.0（`docs/LICENSE`、`benchmark/LICENSE`）。本仓库自带的第三方文件如下，各自适用原来的许可。npm 依赖不随仓库分发，由 `npm ci` 安装，许可见各包自己的 `package.json` 和 LICENSE。

## 随仓库分发

| 路径 | 内容 | 来源 | 许可 |
|---|---|---|---|
| `vendor/three/build/`、`vendor/three/examples/jsm/`（下面三行除外） | three.js r186（0.186.1）的核心和 addons，未修改 | npm 包 `three@0.186.1` | MIT，见 `vendor/three/LICENSE` |
| `vendor/three/examples/jsm/libs/draco/gltf/` | Draco 解码器（wasm 及其 JS 封装） | 随 three.js 分发，源自 google/draco | Apache-2.0 |
| `vendor/three/examples/jsm/libs/meshopt_decoder.module.js` | meshoptimizer 解码器 | 随 three.js 分发，作者 Arseny Kapoulkine | MIT（见文件头） |
| `vendor/three/examples/fonts/helvetiker_bold.typeface.json` | Helvetiker 字体（typeface.js 格式） | three.js 仓库 r186 的 examples/fonts | MgOpen 许可，见 `vendor/three/examples/fonts/LICENSE-helvetiker` |
| `public/fonts/bricolage-*.woff2` | Bricolage Grotesque 字体（界面标题用） | github.com/ateliertriay/bricolage | SIL Open Font License 1.1，见 `public/fonts/OFL.txt` |

`vendor/three/VERSION` 逐个列出了 three.js 里取了哪些文件、各自的来源。

## 本项目自己的内容

- `vendor/kit3d/`：程序化 3D 细节工具包，本项目编写，不包含第三方代码。
- `skills/video-3d/`：本项目编写的技能，组织方式参考了 [CloudAI-X/threejs-skills](https://github.com/CloudAI-X/threejs-skills)（MIT），内容为重写。
- `public/` 里的界面图标：内联 SVG，本项目绘制。

## 不随仓库分发，运行时需要

| 资源 | 用途 | 获取方式 |
|---|---|---|
| Noto Sans CJK（SC） | 字幕、代码镜头和 3D 贴图里的中文 | 系统字体包（如 `fonts-noto-cjk`），用 `fc-match` 查找；许可为 SIL OFL 1.1 |
| Google Chrome | 无头渲染代码镜头和 3D 镜头 | 系统安装，路径用 `CHROME_PATH` 指定 |
| FFmpeg | 剪辑、混音、编码、画面检查 | 系统安装；带 libvidstab 时防抖效果更好，没有也能用 |
| 第三方技能 video-shotcraft（Apache-2.0，含其自带的背景音乐） | 分镜手法、背景音乐 | `npm run skill:add <git-url>` 安装到 `skills/`，见 README |

## 运行时下载的素材

资料片和 3D 模型由 agent 在运行时从公开库下载，每个素材的来源、许可和署名记在会话目录的 `assets_manifest.json` 里，成片片尾自动生成署名：

- NASA 图片与视频库：美国政府作品，公有领域。署名为企业或合作机构的条目不按 NASA 公有领域处理；ESA/Hubble、ESA/Webb 的条目按 CC BY 4.0 处理并带上署名。
- Wikimedia Commons：按条目许可，只采用允许用于剪辑成片的许可（公有领域、CC0、CC BY、CC BY-SA）。
- Poly Haven：CC0。
- NASA 3D Resources、NASA SVS：按条目许可。
- 网络图片（`find_web_image` / `use_web_image`）：任意公开网页上的图片，包括 App Store 图标；不核实版权，只记录页面地址、图片地址和获取时间，署名为"网络图片（站点）"。

这些素材不在仓库里。
