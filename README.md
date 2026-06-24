# AIxiao

[![Release](https://img.shields.io/github/v/release/jia-yawei/AIxiao?include_prereleases)](https://github.com/jia-yawei/AIxiao/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

AIxiao 是一款面向 Markdown 文档整理和写作的桌面工具，基于 Electron + React + Milkdown Crepe 构建。它保留了 Typora 风格的所见即所得编辑体验，并在此基础上加入了 AI 对话、局部改写、Git 管理、文件夹工作区和外部文档同步等功能。

> 当前截图还没有完全同步到最新界面，README 暂不展示旧截图，避免和实际版本不一致。后续更新截图后再补充。

## 主要功能

- Markdown 所见即所得编辑，支持源码模式切换
- 文件夹工作区、文件树、多标签页和左右分屏
- Mermaid 流程图、LaTeX 公式、代码高亮、表格、图片和任务列表
- AI 对话侧边栏，支持 OpenAI 兼容接口和 DeepSeek
- AI 局部改写：可只修改当前选中的 Markdown 内容
- Git 管理：查看变更、暂存、取消暂存、提交、分支管理和提交历史
- Diff 标签页：查看工作区变更和历史提交差异
- 外部 Markdown 文件/文件夹导入，并支持手动同步来源
- 自定义主题、页面宽度、图床上传命令
- 未保存草稿、会话和最近文件恢复

## AI 与 Git

AIxiao 的 AI 功能偏向文档写作场景：总结内容、调整格式、整理表格、改写选区。模型由用户在设置窗口中配置，软件不会内置 API Key。

Git 功能用于本地文档变更管理，方便在保存和提交前查看差异。它不会自动推送远程仓库；是否提交、是否推送都由用户自己决定。

## 安装

前往 [Releases](https://github.com/jia-yawei/AIxiao/releases/latest) 下载最新版。

Windows 版本通常下载：

```text
AIxiao Setup 1.0.0.exe
```

当前安装包未进行代码签名，Windows 可能会弹出 SmartScreen 提示。点击“更多信息”后选择“仍要运行”即可。

## 开发

```bash
npm install
npm run dev
npm run build
npm run dist
```

如果 Windows 终端找不到 `npm`，可以使用完整路径：

```powershell
& "C:\Program Files\nodejs\npm.cmd" run dist
```

只生成解压版：

```powershell
& "C:\Program Files\nodejs\npm.cmd" run dist:dir
```

如果 Electron 或 electron-builder 下载较慢，可以设置镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 致谢

AIxiao 基于开源项目 HorseMD fork 并继续扩展。感谢原作者和原项目贡献者提供了优秀的 Markdown 编辑器基础，包括 Electron 外壳、Milkdown 编辑体验、文件树、多标签页、主题和大量工程实现。

本项目会继续遵守原项目的开源许可，并在此基础上维护 AI、Git 管理和文档工作流相关功能。

## 许可证

[MIT](./LICENSE)
