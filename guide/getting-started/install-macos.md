---
title: macOS 安装
description: 在 Apple 芯片或 Intel Mac 上安装 HorseMD，并处理未签名应用提示。
---

# macOS 安装

<span class="version-badge">适用于 HorseMD v0.6.5</span>

先根据[下载正确的版本](/getting-started/download)选择 Apple 芯片或 Intel 安装包。

## 安装应用

1. 双击下载好的 `.dmg` 文件。
2. 将 HorseMD 图标拖入“应用程序”文件夹。
3. 打开访达，进入“应用程序”。
4. 第一次启动时，按住 Control 点击 HorseMD，选择“打开”。
5. 在系统确认窗口中再次点击“打开”。

当前 macOS 构建没有 Apple Developer ID 签名与公证。直接双击时，系统可能提示“无法验证开发者”或“已损坏”。优先使用上面的 Control 点击方法。

## 仍提示“已损坏”

打开“终端”，执行：

```bash
xattr -cr /Applications/HorseMD.app
```

执行后回到“应用程序”重新打开 HorseMD。命令只清除这个应用的下载隔离属性，不会修改你的 Markdown 文档。

::: danger 确认应用来源
只对从 HorseMD 官网或 GitHub Release 下载的应用执行该命令。不要对来源不明的软件批量清除安全属性。
:::

## 更新版本

退出正在运行的 HorseMD，打开新版 `.dmg`，再次将应用拖入“应用程序”并选择替换。若 macOS 仍复用旧进程，请彻底退出后再打开。

安装完成后继续阅读[第一次启动](/getting-started/first-launch)。
