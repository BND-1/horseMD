# HorseMD

[![CI](https://github.com/BND-1/horseMD/actions/workflows/ci.yml/badge.svg)](https://github.com/BND-1/horseMD/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/BND-1/horseMD?include_prereleases)](https://github.com/BND-1/horseMD/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> **GitHub**: [BND-1/horseMD](https://github.com/BND-1/horseMD) ·
> **Gitee（国内镜像）**: [yty11167/horse-md](https://gitee.com/yty11167/horse-md) ·
> **官网**: [horsemd.yangsir.net](https://horsemd.yangsir.net)

[English](./README.en.md) · **简体中文**

一款温暖、现代的 **Markdown 编辑器** —— 一个更顺手的 Typora 替代品，核心理念是
Typora 做反了的那件事：**每个文件都作为标签页在同一个窗口里打开**，而不是新开一个
程序。左侧文件树浏览整个文件夹，标签页之间随手切换，在干净的所见即所得编辑器里
书写。

![HorseMD —— 文件夹工作区、标签页与所见即所得实时渲染](./docs/screenshots/hero_light.png)

## 为什么是 HorseMD

大多数 Markdown 编辑器逼你二选一：要么漂亮的所见即所得，要么真正的多文件工作流。
HorseMD 两个都给你：一个**单窗口**装下整个文件夹的文件树、每个打开的文档都是一个
**标签页**，编辑器基于 [Milkdown](https://milkdown.dev/)（ProseMirror）原地实时
预览。一套代码同时跑在 **Windows、macOS 和 Linux** 上，整个界面**中英文**实时可切。

## 功能

**编辑 —— Typora 有的都有**

- 流畅的**所见即所得实时预览** —— 输入 Markdown，原地渲染
- 行首 `/` 斜杠菜单插入块；智能列表、选中工具条、链接悬浮提示
- 表格（**单元格内可换行**）、**带语法高亮的代码块**、**LaTeX 数学公式**、**Mermaid 图表**、图片、任务列表、引用块
- **可配置图床** —— 粘贴 / 拖入 / 上传图片走你的上传命令（类 Typora），自动插入返回链接；**支持 PicGo 客户端**（填 `picgo` 即走其本地服务，和 Typora 一样）
- **源码模式**切换（`Ctrl/Cmd+/`）查看原始 Markdown —— 保持滚动位置
- **纯文本文件（`.txt`）用快速纯文本编辑器打开** —— 不走 Markdown 重排，大文件秒开
- 富文本复制（带内联样式）—— 粘到公众号 / 邮件 / Notion 也能保留格式
- **导出为 PDF**（`Ctrl/Cmd+Shift+E`）—— 排版干净，不带编辑器控件
- 相对路径图片按文件所在目录解析（仅显示用，不改动你的文件内容）
- **双击图片放大查看**（灯箱预览，点背景 / Esc 关闭；单击仍可选中图片、加说明）
- **原生 HTML 表格**（文档里直接写的 `<table>…</table>`）渲染成真正的表格，和 Typora 一样 —— 仅显示，源码原样保留
- 跟随光标的**浮动块级标记**（H1…H6 / 正文）

**超出 Typora**

- **标签页** —— 多文件同窗（`Ctrl/Cmd+Tab` 循环切换）；顶栏一个 `+` 快速新建文档；标签右键可复制路径 / 复制文件名 / 打开所在文件夹 / 关闭其他
- **分屏** —— 两个文档左右并排、都可编辑（标签右键"在右侧分屏打开"或顶栏分屏按钮，右上 ✕ 关闭）
- **自定义页面宽度** —— 状态栏分段预设（窄/中/宽/全宽）+ 微调滑块
- **自定义文档 / 代码字体** —— 设置页分别选文档字体和代码字体；从系统已装字体里选（下拉 + 搜索 + 每字体实时预览），代码可用 Nerd Font 等
- **自定义主题** —— 把 `.css` 丢进主题文件夹即可，**可直接迁移 Typora 主题**
- **未保存草稿不丢** —— 新建但没保存的临时文档，关掉再开也还在
- **文件夹工作区** —— 文件树，原地新建 / 重命名 / 复制一份 / 删除 / 在访达中显示 / 导出 PDF，支持**拖拽移动**与展开全部 / 折叠全部
- **在同一窗口打开** —— 双击文件 → 加一个标签；对文件夹"用 HorseMD 打开" → 作为工作区打开
- **命令面板**（`Ctrl/Cmd+P`）—— 模糊跳转到任意文件或命令
- **文档内查找**（`Ctrl/Cmd+F`）—— 在文档里高亮匹配并实时计数
- **大纲面板**（`Ctrl+Shift+L`）—— 点标题即跳转（自定义 ease-out 动画 + 精准落点），**宽度可拖拽调整**（双击恢复默认，重启保持）
- **设置页**（左下角齿轮）—— 排版（字号/行距/段距/页宽 + 实时预览）、外观（主题 + 显示隐藏文件）、校对（英文拼写检查开关）、语言、图床、关于
- **Mermaid 全屏灯箱** —— 点击流程图全屏查看，Ctrl+滚轮缩放 + 拖拽平移
- **标签拖拽排序** —— 按住标签拖到新位置，顺序持久化
- **源码↔富文本切换保持位置** —— 切换后仍在同一标题附近
- 实时字数 / 字符数与阅读时长
- 会话恢复 —— 重新打开你的文件夹和标签
- 文件树与打开的文件自动刷新 —— 监听外部改动
- **主页按钮**（活动栏）—— 随时回到欢迎页（已打开的标签仍保持加载）
- **大文档加载骨架屏** —— 打开大文件不再是一段空白
- 关闭窗口 / 退出时提醒未保存（不只是关标签）
- 仅通知的更新检查 —— 有新版本时提示**并展示更新内容**（不自动下载）；设置页可**手动检查更新**

命令面板 —— 模糊跳转到任意文件或命令：

![命令面板](./docs/screenshots/command_palette.png)

## 主题

六套精心调过的主题 —— 暖光 / 暖夜，外加四套低饱和的**莫兰迪**配色 ——
`Ctrl+Shift+T` 或状态栏选择器切换。

| 暖光 | 暖夜 | 莫兰迪·暮 |
| :---: | :---: | :---: |
| ![暖光](./docs/screenshots/hero_light.png) | ![暖夜](./docs/screenshots/theme_dark.png) | ![莫兰迪·暮](./docs/screenshots/theme_morandi_dusk.png) |
| **莫兰迪·灰绿** | **莫兰迪·豆沙** | **莫兰迪·雾蓝** |
| ![莫兰迪·灰绿](./docs/screenshots/theme_morandi_sage.png) | ![莫兰迪·豆沙](./docs/screenshots/theme_morandi_rose.png) | ![莫兰迪·雾蓝](./docs/screenshots/theme_morandi_mist.png) |

## 快捷键

| 操作               | 快捷键                        |
| ------------------ | ----------------------------- |
| 新建文件           | `Ctrl/Cmd+N`                  |
| 打开文件           | `Ctrl/Cmd+O`                  |
| 打开文件夹         | `Ctrl/Cmd+Shift+O`            |
| 保存 / 另存为      | `Ctrl/Cmd+S` / `…+Shift+S`    |
| 导出为 PDF         | `Ctrl/Cmd+Shift+E`            |
| 关闭标签           | `Ctrl/Cmd+W`                  |
| 命令面板           | `Ctrl/Cmd+P`                  |
| 文档内查找         | `Ctrl/Cmd+F`                  |
| 加粗               | `Ctrl/Cmd+B`                  |
| 切换侧边栏         | `Ctrl/Cmd+Shift+B`            |
| 切换大纲           | `Ctrl+Shift+L`                |
| 切换源码模式       | `Ctrl/Cmd+/`                  |
| 切换主题           | `Ctrl+Shift+T`                |
| 循环标签           | `Ctrl+Tab` / `Ctrl+Shift+Tab` |

## 安装

去 [**Releases 页面**](https://github.com/BND-1/horseMD/releases/latest) 下载最新版安装包。

> ℹ️ 安装包目前**没有花钱买签名**，所以 Windows / macOS 第一次打开都会拦一下——**不是病毒、不是真的损坏**，按下面步骤放行即可。代码完全开源，可自行查看 / 构建。

### 🍎 macOS 安装（新手请按这个来）

1. 确认你的芯片：左上角 **苹果菜单 →「关于本机」**：
   - 看到 **「Apple M1 / M2 / M3…」**（Apple Silicon）→ 下载 **`HorseMD-x.x.x-arm64.dmg`**。
   - 看到 **「Intel」** → 下载 **`HorseMD-x.x.x.dmg`**（不带 `-arm64` 后缀的那个）。
2. 双击下载好的 `.dmg`，把里面的 **HorseMD 图标拖到「应用程序」文件夹**。
3. **第一次打开**（重要）：直接双击通常会提示 **「已损坏，无法打开」或「无法验证开发者」**——这是因为没签名，正常现象。任选一种方法放行：

   - **方法 A（最简单，推荐）**：打开「访达 →『应用程序』」，找到 HorseMD，**按住 Control 键点它（或右键）→ 选「打开」**，在弹窗里再点一次 **「打开」**。之后就能像普通软件一样双击使用了。
   - **方法 B（如果方法 A 仍提示「已损坏」）**：打开「**终端**」（在「启动台 → 其他 → 终端」，或 Spotlight 搜 `终端`），把下面这行**整段复制粘贴进去、按回车**：

     ```bash
     xattr -cr /Applications/HorseMD.app
     ```

     然后再回到「应用程序」双击 HorseMD 即可正常打开。

> 这一步**每台电脑只需做一次**，以后更新版本一般也不用再弄。

### 🪟 Windows 安装

1. 下载 **`HorseMD-Setup-x.x.x.exe`**，双击运行。
2. 若弹出蓝色的 **SmartScreen**「Windows 已保护你的电脑」，点 **「更多信息」→「仍要运行」**。
3. 按提示安装（可以自己选安装目录），完成后从开始菜单或桌面打开。

> 签名与公证在计划中 —— 见 [CHANGELOG](./CHANGELOG.md)。

### 🐧 Linux 安装

1. 下载 **`horse_x.x.x_amd64.deb`**（Ubuntu / Debian 系，x64）。
2. 双击用软件中心安装，或在终端运行：
   ```bash
   sudo dpkg -i horse_x.x.x_amd64.deb
   sudo apt-get install -f   # 自动补齐依赖
   ```
3. 从应用菜单启动。需要从终端启动时使用 `/opt/HorseMD/horse`。

> 目前提供 **.deb（amd64）**；其他发行版（Fedora / Arch 等）可从源码构建（见下方「从源码构建」）。运行依赖：libgtk-3-0、libnotify4、libnss3、libxss1、libxtst6、xdg-utils、libatspi2.0-0、libuuid1、libsecret-1-0。

## 社群 & 支持

用得顺手的话，欢迎来玩 🐎 一起交流 Markdown 写作、提需求、报 bug。

| 加我微信 · 拉你进群 | 微信群（直接扫码） | 请我喝杯咖啡 ☕ |
| :---: | :---: | :---: |
| <img src="./docs/community/wechat-personal.jpg" width="220" alt="作者微信"> | <img src="./docs/community/wechat-group.jpg" width="220" alt="HorseMD 交流群"> | <img src="./docs/community/coffee.jpg" width="220" alt="请作者喝咖啡"> |
| 加好友备注「HorseMD」，拉你进群，也欢迎直接交流 | 扫码进群（群码会定期更新，**过期就加左边的微信**） | 觉得好用，请作者喝杯咖啡，是持续更新的最大动力 |

## 开发

```bash
npm install        # 若 Electron 二进制下载被墙，先设镜像：
                   #   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev        # 热重载开发模式
npm run build      # 构建 main + preload + renderer 到 out/
npm start          # 运行构建产物
npm run dist       # 按当前系统出包（Windows NSIS / macOS dmg+zip / Linux deb）
```

用 AI 助手在本仓库里干活？从 [CLAUDE.md](./CLAUDE.md) 开始。

## 技术栈

Electron + Vite + React 外壳，编辑器引擎用 **Milkdown Crepe**（基于 ProseMirror）。
外壳（标签页、文件树、命令面板、大纲、主题、多语言）全部自研。架构、功能实现、
踩坑与决策记录见 [`docs/`](./docs/README.md)。

## 文档

- [HorseMD 使用教程](https://guide.horsemd.yangsir.net/) —— 安装、功能介绍、详细操作与常见问题
- [ROADMAP.md](./ROADMAP.md) —— 已完成 / 近期计划 / 远期(含安卓、iOS 移动端)
- [docs/architecture.md](./docs/architecture.md) —— 技术栈、进程模型、目录结构、数据流
- [docs/features.md](./docs/features.md) —— 每个功能的用法与实现（对应到文件）
- [docs/implementation-notes.md](./docs/implementation-notes.md) —— 关键 bug 的根因与修法、设计决策
- [docs/development.md](./docs/development.md) —— 开发、构建、Windows/macOS/Linux 打包、CDP 自动化测试
- [docs/user-guide-maintenance.md](./docs/user-guide-maintenance.md) —— 教程站内容、截图和版本维护规范

## 贡献

欢迎提 Issue 和 PR —— 见 [CONTRIBUTING.md](./CONTRIBUTING.md)。发现安全问题？
请通过 [SECURITY.md](./SECURITY.md) 私下报告。

## 许可证

[MIT](./LICENSE) © 杨庭毅 ([yangsir.net](https://yangsir.net))
