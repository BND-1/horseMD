---
title: 下载正确的版本
description: 根据平台（Windows、macOS、Linux、Android）选择 HorseMD 安装包。
---

# 下载正确的版本

<span class="version-badge">适用于 HorseMD v0.6.0</span>

打开 [HorseMD 官网](https://horsemd.yangsir.net/) 或 [GitHub Releases](https://github.com/BND-1/horseMD/releases/latest)。Release 页面中还会出现校验文件、源码压缩包和更新描述文件，普通用户只需要下载下表中的安装文件。

| 你的设备 | 下载文件 | 不要选错 |
| --- | --- | --- |
| Windows 10/11，64 位 | `HorseMD-Setup-0.6.0.exe` | 不要下载 `.blockmap` |
| Apple M1/M2/M3/M4 等芯片 | `HorseMD-0.6.0-arm64.dmg` | 文件名必须包含 `arm64` |
| Intel 芯片 Mac | `HorseMD-0.6.0.dmg` | 文件名不包含 `arm64` |
| Linux（Ubuntu/Debian，64 位） | `horse_0.6.0_amd64.deb` | 其他发行版见 Linux 安装页 |
| Android 手机或平板 | `HorseMD-0.6.0.apk` | 不要下载桌面安装包 |

## 查看 Mac 芯片

点击屏幕左上角的苹果菜单，选择“关于本机”：

- “芯片”显示 Apple M1、M2、M3、M4 或更新型号：下载 `arm64.dmg`。
- “处理器”显示 Intel：下载不带 `arm64` 的 `.dmg`。

下载错误架构通常不会损坏文件，但应用可能无法启动，或者系统提示与设备不兼容。

## 识别 Release 中的其他文件

`.blockmap` 和 `latest.yml` 是桌面更新机制使用的元数据，不是安装包。`Source code` 是 GitHub 自动生成的源代码压缩包，也不能直接安装。

::: tip 始终使用 latest 页面
收藏 `https://github.com/BND-1/horseMD/releases/latest`，它会自动跳转到最新正式版本，避免误装旧版本或测试构建。
:::

下载完成后，继续阅读 [Windows 安装](/getting-started/install-windows)、[macOS 安装](/getting-started/install-macos)、[Linux 安装](/getting-started/install-linux) 或 [Android 安装](/getting-started/install-android)。
