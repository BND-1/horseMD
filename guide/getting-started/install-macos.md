---
title: macOS 安装
description: 在 Apple 芯片或 Intel Mac 上安装 HorseMD，并处理未签名应用提示。
---

# macOS 安装

<span class="version-badge">适用于 HorseMD v0.13.29</span>

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

有新版本时，HorseMD 右下角会弹出“发现新版本”。点 **直接下载**，HorseMD 会在后台下载并校验安装包，下载完成后点 **重启并安装**，HorseMD 会退出、替换“应用程序”里的旧版并自动重新打开。下载前会自动比较 GitHub 和国内加速镜像的速度，选最快的线路；无论从哪里下载，都用 GitHub 公布的校验值核对。有未保存的文档时会先询问。也可以在“设置 › 关于 › 检查更新”里手动检查。

如果 HorseMD 不在“应用程序”文件夹里运行（例如直接从 `.dmg` 打开），点“直接下载”会下载并打开新版 `.dmg`，按下面的方法手动替换即可。

手动更新：退出正在运行的 HorseMD，打开新版 `.dmg`，再次将应用拖入“应用程序”并选择替换。若 macOS 仍复用旧进程，请彻底退出后再打开。

安装完成后继续阅读[第一次启动](/getting-started/first-launch)。
