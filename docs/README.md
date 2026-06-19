# HorseMD 开发文档

这套文档记录 **HorseMD** 的架构、功能实现方式、开发/打包流程，以及开发过程中发现并修复的关键问题与设计决策。

> HorseMD 是一款温暖、现代的 Markdown 编辑器 —— 一个 Typora 替代品，核心理念：**每个文件都在同一个窗口里作为标签页打开**，而不是新开一个程序。

## 文档目录

| 文档 | 内容 |
| --- | --- |
| [architecture.md](./architecture.md) | 技术栈、进程模型、目录结构、关键模块与数据流 |
| [features.md](./features.md) | 每个功能的用法 + 实现方式（对应到具体文件） |
| [implementation-notes.md](./implementation-notes.md) | 开发过程中踩的坑、关键 bug 的根因与修法、设计决策 |
| [development.md](./development.md) | 本地开发、构建、打包（Windows / macOS）、自动化测试方法 |
| [mobile.md](./mobile.md) | 移动端（iOS / Android · Capacitor）方案、接口适配、打包发布 |
| [mobile-usage.md](./mobile-usage.md) | 移动端**使用说明**(安装、界面、保存/导出等操作) |

## 一句话技术概览

Electron + Vite + React 外壳，编辑器引擎用 **Milkdown Crepe**（基于 ProseMirror 的所见即所得）。外壳（标签页、文件树、命令面板、大纲、主题、i18n、首页）全部自研。

## 快速开始

```bash
npm install        # 若 Electron 二进制下载被墙，先设镜像：
                   #   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev        # 热重载开发模式
npm run build      # 打包 main + preload + renderer 到 out/
npm start          # 运行已构建的应用
npm run dist       # 打当前系统安装包（Windows NSIS / macOS dmg+zip）
```

> 仓库根目录的 [CLAUDE.md](../CLAUDE.md) 是给 AI / 新同学的速查（命令、约定、跨平台规则），细节看本目录各篇。
