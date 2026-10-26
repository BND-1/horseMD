---
title: Linux 安装
description: 在 Ubuntu / Debian（.deb）和 Arch Linux（pacman 包）上安装 HorseMD。
---

# Linux 安装

<span class="version-badge">适用于 HorseMD v0.13.29</span>

Linux 版提供两种安装包（均为 x86_64 / amd64）：

- **.deb**：Ubuntu、Debian、Linux Mint 等 Debian 系发行版，文件名形如 `horse_0.13.29_amd64.deb`。
- **.pkg.tar.xz**：Arch Linux、Manjaro、EndeavourOS 等 Arch 系发行版，文件名形如 `horse-0.13.251-x86_64.pkg.tar.xz`（v0.13.251 起提供），安装方法见下方 [Arch Linux](#arch-linux)。

先从[下载正确的版本](/getting-started/download)获取对应的文件。

## 安装应用（Ubuntu / Debian）

### 图形化安装

双击下载的 `.deb` 文件，用「软件安装」「GDebi」或「Discover」打开，点击安装即可，系统会自动处理依赖。

### 命令行安装（推荐）

打开终端，进入下载目录执行：

```bash
sudo apt install ./horse_0.13.29_amd64.deb
```

`apt install ./文件名.deb` 会同时安装 HorseMD 和缺少的系统依赖。若已经用
`dpkg -i` 安装并遇到依赖错误，再执行 `sudo apt-get install -f` 修复即可。

## 运行依赖

.deb 安装时会自动声明依赖。若手动安装遇到缺少库，确认已装：

- libgtk-3-0、libnotify4、libnss3、libxss1、libxtst6
- xdg-utils、libatspi2.0-0、libuuid1、libsecret-1-0

## Arch Linux

在下载目录执行：

```bash
sudo pacman -U ./horse-0.13.251-x86_64.pkg.tar.xz
```

pacman 会同时安装缺少的系统依赖（gtk3、nss、alsa-lib 等，都来自官方仓库）。安装包未签名，本地安装默认不要求签名；如果你的 `pacman.conf` 把 `LocalFileSigLevel` 设成了 `Required`，请临时改回 `Optional`。

更新时下载新版后重复同一条命令；卸载用 `sudo pacman -R horse`。HorseMD 提示“发现新版本”时，点“直接下载”会把对应的安装包下载到“下载”文件夹并打开所在位置（安装需要管理员密码，所以仍需运行上面的命令）。

## 启动

从应用菜单找到「HorseMD」启动。需要从终端启动时运行：

```bash
horse
```

（命令 `horse` 是指向 `/opt/HorseMD/horse` 的链接。）

在文件管理器中双击 `.md` 文件，或使用“打开方式 → HorseMD”，也可以通过安装包注册的 Markdown 文件关联打开文档。

## 其他发行版（Fedora 等）

目前没有官方 RPM、AppImage、Flatpak 或 AUR 包。直接转换 `.deb` 可能产生无法正确处理依赖和桌面集成的非官方包，不建议作为默认安装方法。Fedora 等发行版请暂时从源码构建，见[仓库说明](https://github.com/BND-1/horseMD#从源码构建)。

::: tip 未签名构建
Linux 版未经签名。安装时若提示信任问题，确认包来自 HorseMD 官方 GitHub Release 后继续即可。
:::

## 更新版本

退出正在运行的 HorseMD，下载新版安装包，重复上面的安装命令即可覆盖更新。你的配置与文档不受影响。

## 卸载

```bash
sudo apt remove horse      # Ubuntu / Debian
sudo pacman -R horse       # Arch
```

卸载应用不会删除你自己保存的 Markdown 文件。

安装完成后继续阅读[第一次启动](/getting-started/first-launch)。
