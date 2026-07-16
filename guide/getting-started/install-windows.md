---
title: Windows 安装
description: 在 Windows 10 或 Windows 11 中安装 HorseMD，并处理 SmartScreen 提示。
---

# Windows 安装

<span class="version-badge">适用于 HorseMD v0.6.5</span>

HorseMD 当前提供 x64 NSIS 安装包，适用于常见的 Windows 10 和 Windows 11 电脑。

## 安装步骤

1. 下载 `HorseMD-Setup-0.6.5.exe`。
2. 双击安装文件。
3. 如果 Windows SmartScreen 显示“Windows 已保护你的电脑”，点击“更多信息”。
4. 确认应用名称是 HorseMD，然后点击“仍要运行”。
5. 在安装向导中选择安装目录并完成安装。
6. 从开始菜单或桌面快捷方式打开 HorseMD。

当前安装包尚未购买商业代码签名证书，所以 SmartScreen 可能显示“未知发布者”。这不代表安装包被判定为病毒。建议只从官网或 GitHub Release 下载，并在需要时对照开源仓库和 Release 文件名。

::: warning 不要把文档放进安装目录
Markdown 文档应保存在“文档”、桌面、同步盘或自己的项目文件夹中。不要把个人文件保存在 HorseMD 的程序安装目录里。
:::

## 更新版本

安装新版本前通常不需要卸载旧版本。退出 HorseMD，运行新版安装包并覆盖安装即可。工作区路径、最近文件和外观设置保存在用户数据目录中，不在应用安装目录内。

如果 Windows 阻止安装、安装后打不开或文件关联异常，请查看[安装问题](/troubleshooting/installation)。
