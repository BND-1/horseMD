# HorseMD

[![CI](https://github.com/BND-1/horseMD/actions/workflows/ci.yml/badge.svg)](https://github.com/BND-1/horseMD/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/BND-1/horseMD?include_prereleases)](https://github.com/BND-1/horseMD/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md) · **简体中文**

一款温暖、现代的 **Markdown 编辑器** —— 一个更顺手的 Typora 替代品，核心理念是
Typora 做反了的那件事：**每个文件都作为标签页在同一个窗口里打开**，而不是新开一个
程序。左侧文件树浏览整个文件夹，标签页之间随手切换，在干净的所见即所得编辑器里
书写。

![HorseMD —— 文件夹工作区、标签页与所见即所得实时渲染](./docs/screenshots/hero_light.png)

## 为什么是 HorseMD

大多数 Markdown 编辑器逼你二选一：要么漂亮的所见即所得，要么真正的多文件工作流。
HorseMD 两个都给你：一个**单窗口**装下整个文件夹的文件树、每个打开的文档都是一个
**标签页**，编辑器基于 [Milkdown](https://milkdown.dev/)（ProseMirror）原地实时
预览。一套代码同时跑在 **Windows 和 macOS** 上，整个界面**中英文**实时可切。

## 功能

**编辑 —— Typora 有的都有**

- 流畅的**所见即所得实时预览** —— 输入 Markdown，原地渲染
- 行首 `/` 斜杠菜单插入块；智能列表、选中工具条、链接悬浮提示
- 表格、**带语法高亮的代码块**、**LaTeX 数学公式**、图片、任务列表、引用块
- **源码模式**切换（`Ctrl/Cmd+/`）查看原始 Markdown
- **纯文本文件（`.txt`）用快速纯文本编辑器打开** —— 不走 Markdown 重排，大文件秒开
- 富文本复制（带内联样式）—— 粘到公众号 / 邮件 / Notion 也能保留格式
- 相对路径图片按文件所在目录解析（仅显示用，不改动你的文件内容）

**超出 Typora**

- **标签页** —— 多文件同窗（`Ctrl/Cmd+Tab` 循环切换）；顶栏一个 `+` 快速新建文档
- **文件夹工作区** —— 文件树，原地新建 / 重命名 / 删除 / 在访达中显示
- **在同一窗口打开** —— 在访达 / 资源管理器双击文件 → 加一个标签，而不是新开程序
- **命令面板**（`Ctrl/Cmd+P`）—— 模糊跳转到任意文件或命令
- **大纲面板**（`Ctrl+Shift+L`）—— 点标题即跳转
- 实时字数 / 字符数与阅读时长
- 会话恢复 —— 重新打开你的文件夹和标签
- 文件树自动刷新 —— 监听文件夹的外部改动

| 暗色主题 | 命令面板 |
| --- | --- |
| ![暗色主题](./docs/screenshots/theme_dark.png) | ![命令面板](./docs/screenshots/command_palette.png) |

六套精心调过的主题（暖光 / 暖夜 + 四套莫兰迪配色），`Ctrl+Shift+T` 或状态栏选择器切换。

## 快捷键

| 操作               | 快捷键                        |
| ------------------ | ----------------------------- |
| 新建文件           | `Ctrl/Cmd+N`                  |
| 打开文件           | `Ctrl/Cmd+O`                  |
| 打开文件夹         | `Ctrl/Cmd+Shift+O`            |
| 保存 / 另存为      | `Ctrl/Cmd+S` / `…+Shift+S`    |
| 关闭标签           | `Ctrl/Cmd+W`                  |
| 命令面板           | `Ctrl/Cmd+P`                  |
| 文档内查找         | `Ctrl/Cmd+F`                  |
| 切换侧边栏         | `Ctrl/Cmd+B`                  |
| 切换大纲           | `Ctrl+Shift+L`                |
| 切换源码模式       | `Ctrl/Cmd+/`                  |
| 切换主题           | `Ctrl+Shift+T`                |
| 循环标签           | `Ctrl+Tab` / `Ctrl+Shift+Tab` |

## 安装

从 [**Releases**](https://github.com/BND-1/horseMD/releases) 下载最新安装包：

- **Windows** —— `HorseMD Setup x.x.x.exe`。安装包目前**未签名**，首次运行
  SmartScreen 可能拦截：点**更多信息 → 仍要运行**。
- **macOS** —— `HorseMD-x.x.x.dmg`（Apple Silicon）。目前**未签名、未公证**，
  Gatekeeper 可能提示"已损坏"。拖到"应用程序"后，在终端跑一次：

  ```bash
  xattr -cr /Applications/HorseMD.app
  ```

  再正常打开即可。（签名与公证在计划中 —— 见 [CHANGELOG](./CHANGELOG.md)。）

## 开发

```bash
npm install        # 若 Electron 二进制下载被墙，先设镜像：
                   #   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev        # 热重载开发模式
npm run build      # 构建 main + preload + renderer 到 out/
npm start          # 运行构建产物
npm run dist       # 按当前系统出包（Windows NSIS / macOS dmg+zip）
```

用 AI 助手在本仓库里干活？从 [CLAUDE.md](./CLAUDE.md) 开始。

## 技术栈

Electron + Vite + React 外壳，编辑器引擎用 **Milkdown Crepe**（基于 ProseMirror）。
外壳（标签页、文件树、命令面板、大纲、主题、多语言）全部自研。架构、功能实现、
踩坑与决策记录见 [`docs/`](./docs/README.md)。

## 文档

- [docs/architecture.md](./docs/architecture.md) —— 技术栈、进程模型、目录结构、数据流
- [docs/features.md](./docs/features.md) —— 每个功能的用法与实现（对应到文件）
- [docs/implementation-notes.md](./docs/implementation-notes.md) —— 关键 bug 的根因与修法、设计决策
- [docs/development.md](./docs/development.md) —— 开发、构建、Windows/macOS 打包、CDP 自动化测试

## 贡献

欢迎提 Issue 和 PR —— 见 [CONTRIBUTING.md](./CONTRIBUTING.md)。发现安全问题？
请通过 [SECURITY.md](./SECURITY.md) 私下报告。

## 许可证

[MIT](./LICENSE) © 杨庭毅 (BND-1)
