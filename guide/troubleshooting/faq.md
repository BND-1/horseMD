---
title: 常见问题
description: HorseMD 价格、隐私、平台、格式兼容和功能范围常见问答。
---

# 常见问题

<span class="version-badge">适用于 HorseMD v0.6.5</span>

## HorseMD 收费吗

不收费。HorseMD 使用 MIT 协议开源，不需要账号。项目可能接受赞助，但不会影响本地编辑功能。

## 文档会上传到服务器吗

桌面文件直接保存在你选择的磁盘位置。HorseMD 不要求登录或云端同步。只有你主动使用网络图片、自定义图床命令、打开外部链接或检查 GitHub 更新时会发生相应网络访问。

## 支持哪些平台

v0.6.5 正式提供 Windows x64、macOS Apple Silicon、macOS Intel、Linux amd64 和 Android 安装包。iOS 当前需要 Xcode 开发安装。Linux 用户应从官方 Release 下载经过 Ubuntu Runner 校验的 `.deb`。

## 能直接替代 Typora 吗

HorseMD 支持所见即所得、表格、代码、公式、Mermaid、自定义主题和 PDF 导出，并增加标签页、多根工作区、分屏和审阅。但不同 Markdown 引擎对 HTML、主题 CSS 和扩展语法的处理可能不同，迁移重要文档前应保留备份。

## 支持自动云同步吗

HorseMD 本身不提供账号云同步。可以把工作区放在 iCloud Drive、OneDrive、Dropbox、坚果云或 Git 仓库中，由对应工具同步。发生外部冲突时先保留两个版本再合并。

## 可以编辑普通文本吗

可以。`.txt` 等文件使用快速文本编辑器，不经过 Markdown 富文本解析。

## 为什么模式切换没有产生“已修改”

这是正确行为。视图切换和内部内容恢复不属于用户编辑；只有实际输入、删除、替换或格式修改才会标记未保存。

## 在哪里反馈问题

前往 [GitHub Issues](https://github.com/BND-1/horseMD/issues)。请注明版本、平台、复现步骤和预期结果；UI 问题附截图，文件问题尽量提供脱敏示例。
