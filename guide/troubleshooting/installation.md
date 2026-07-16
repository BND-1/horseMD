---
title: 安装问题
description: 处理 HorseMD 在 Windows、macOS 和 Android 上的常见安装与更新问题。
---

# 安装问题

<span class="version-badge">适用于 HorseMD v0.6.5</span>

## Windows 显示未知发布者

确认文件来自官网或 GitHub Release，文件名为 `HorseMD-Setup-版本号.exe`。在 SmartScreen 页面点击“更多信息”，再选择“仍要运行”。如果杀毒软件直接隔离文件，先核对下载来源和 Release，再向项目提交具体软件名称和检测结果。

## macOS 提示无法验证或已损坏

先在“应用程序”中 Control 点击 HorseMD，选择“打开”。仍失败时执行：

```bash
xattr -cr /Applications/HorseMD.app
```

Apple 芯片必须使用 `arm64.dmg`；Intel Mac 使用不带 `arm64` 的文件。

## Android 不允许安装 APK

进入系统设置，临时允许当前浏览器或文件管理器“安装未知应用”。安装完成后可以关闭权限。若提示解析失败，确认 APK 下载完整，并且没有误下载 `.blockmap` 或桌面安装包。

## 检查更新仍显示最新版

HorseMD 只通知新版本，不会自动下载。它读取 GitHub 最新正式 Release 并按语义版本比较。预发布和草稿不会推送。

版本号按数字段比较，例如 `0.5.29` 大于 `0.5.5`。如果曾安装内部测试版本 `0.5.29`，正式发布 `0.5.5` 不会被视为更新；后续正式版本必须高于已分发测试版本。

网络无法访问 GitHub API 时也可能检查失败。可以直接打开 [Releases](https://github.com/BND-1/horseMD/releases/latest) 查看。
