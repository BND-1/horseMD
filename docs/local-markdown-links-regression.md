# 本地 Markdown 链接跳转回归（0.12.63）

## 用户现象

富文本中的普通网页链接可通过 Ctrl/Cmd+点击打开，但下面这种 Markdown 无任何反应：

```md
[文件](</absolute/path/to/target.md>)
```

Typora 等编辑器会把它理解为本地文件链接并交给系统打开。

## 根因

`editor-dom-content.js` 原先只处理两类本地链接：

- 已带 `file://` 协议的 URL；
- 相对于当前 Markdown 的路径。

以 `/` 开头的 POSIX 绝对路径被 `isRelativePath()` 正确排除，却没有进入 `file://` 分支，因此点击事件既不阻止默认导航，也不调用本地文件 IPC。

## 修复合同

`editor-local-links.js` 是唯一的链接目标归一化入口：

- 支持 `file://`、POSIX 绝对路径、Windows 盘符路径、UNC 路径和相对路径；
- 只解码一次既有 `%20`，再编码为 file URL，避免空格、中文路径双重编码；
- `#锚点`、`https:`、`mailto:` 和其他协议不进入本地文件路径；
- 富文本 Ctrl/Cmd+点击本地目标后必须 `preventDefault()`，再调用 `window.api.openFileUrl()`；网页链接继续调用 `openExternal()`；
- 主进程 `shell:openFileUrl` 与 `openExternal` 一样校验调用方必须是主窗口 renderer，并只接受 `file:` URL。

本地文件由 Electron `shell.openPath()` 交给系统关联应用打开；HorseMD 不强制把它作为当前标签打开，避免覆盖用户系统的文件关联选择。

## 回归

```bash
npm run test:local-markdown-links
```

测试覆盖：

1. POSIX、Windows 盘符、UNC、相对路径到 `file://` 的纯函数归一化；
2. 空格、中文与已转义 `%20` 路径不双重编码；
3. 真实后台 Electron 富文本中，Cmd/Ctrl+点击裸绝对路径会进入 file-only IPC 路由并阻止 renderer 导航。

测试刻意使用不存在的目标文件：它验证点击进入了安全的本地文件 IPC，又不会在后台回归中启动外部应用、抢占用户焦点。

## 交付安装验证

0.12.63 使用 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir` 从当前源码重新构建，产物为 `dist/mac-arm64/HorseMD.app`。安装前停止旧的 `/Applications/HorseMD.app` 进程，将旧 app 移至 `/tmp` 作为可恢复备份后再复制新 app、清除 quarantine 并启动。

交付前至少确认：

```bash
plutil -extract CFBundleShortVersionString raw /Applications/HorseMD.app/Contents/Info.plist
ps -ax | rg '/Applications/HorseMD.app/Contents/MacOS/HorseMD'
```

两项分别必须显示当前 `package.json` 版本和 `/Applications/HorseMD.app` 运行路径；不能仅根据 `dist/` 的生成时间宣称用户正在使用最新版。
