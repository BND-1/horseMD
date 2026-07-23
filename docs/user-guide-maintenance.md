# 用户图文教程维护规范

HorseMD 官网负责产品介绍和下载，`guide/` 是面向普通用户的独立 VitePress 教程站。
教程与 `docs/` 的开发者文档职责不同：前者回答“怎么使用”，后者记录“怎么实现、为什么这样实现”。

## 内容结构

- `getting-started/`：下载、平台安装和第一次启动。
- `basics/`：界面、文件、工作区、标签和编辑模式。
- `editing/`：Markdown 内容块、图片、链接和附件。
- `productivity/`：查找、大纲、命令面板、审阅和快捷键。
- `output/`：富文本复制、PDF 和移动分享。
- `customization/`：主题、字体和设置。
- `mobile/`：iOS 与 Android 的平台差异。
- `troubleshooting/`：安装、文件、性能和 FAQ。

每页必须有 `title`、`description`、当前适用版本、明确步骤和必要的边界说明。界面文案以中文正式版本为准，不使用开发变量名替代用户可见名称。

本地测试包和已发布教程要明确分开：开发中的功能可以先补充教程正文、使用边界和人工验收项，但不能把未发布测试包的版本号或截图伪装成正式下载版本。`guide/package.json` 与既有截图目录代表当前公开教程基线；只有准备正式发布时，才统一更新受影响页面的版本徽标、截图和下载说明。每次核对都记录在 [user-guide-feature-coverage.md](./user-guide-feature-coverage.md)。

## 截图标准

- 必须从当前源码重新构建并安装的 `/Applications/HorseMD.app` 采集，不能使用旧安装包或开发热更新窗口。
- macOS 截图使用独立 `--user-data-dir`，避免个人工作区、最近文件和设置进入公开图片。
- 标准尺寸为 1440×900，默认使用暖光主题。
- 截图素材不能出现个人用户名、私人文件、真实项目路径或访问令牌。
- 操作菜单必须通过真实点击和键盘事件打开，不能用 DOM 强行改成显示状态。
- 每张截图都要在教程正文中使用；过期截图按版本目录保留或整体删除，不混用不同版本界面。

### 重新采集

先运行应用回归并构建当前 arm64 目录包：

```bash
npm run test:core
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir
```

按 `AGENTS.md` 的最新安装流程杀掉旧实例、覆盖 `/Applications/HorseMD.app`、清除 quarantine，确认 Info.plist 版本与根 `package.json` 一致。然后把
`guide/public/downloads/HorseMD 教程工作区` 复制到 `/tmp/HorseMD 教程工作区`，用独立用户目录和 CDP 启动：

```bash
open -na /Applications/HorseMD.app --args \
  --remote-debugging-port=9223 \
  --user-data-dir=/tmp/horsemd-guide-profile \
  '/tmp/HorseMD 教程工作区/HorseMD-教程示例.md'

GUIDE_FIXTURE_DIR='/tmp/HorseMD 教程工作区' \
CDP_PORT=9223 npm run guide:capture
```

截图脚本从根 `package.json` 读取版本，输出到 `guide/public/images/vX.Y.Z/`。完成后必须制作联系表或逐张查看，检查裁切、弹层位置、内容状态和路径隐私。

## 版本发布清单

用户可见功能变更时：

1. 在覆盖矩阵中确认受影响功能、对应教程页和截图需求。
2. 更新对应教程正文和功能边界；测试阶段只标注“测试功能”，不改公开下载基线。
3. 准备正式发布时，再把受影响页面的适用版本统一更新为该发布版本，并用当前安装包重拍受影响截图。
4. 同步 `website/index.html`、`index.md`、`llms.txt`、`llms-full.txt` 的静态回退版本和平台信息。
5. 运行 `npm run guide:check`、`npm run test:core`、`npm run build`；共享渲染器变化还要运行 `npm run build:mobile`。
6. 桌面和手机宽度检查教程导航、搜索、图片灯箱和长代码块。

## 部署

教程作为独立 Vercel 项目部署，Project Root 设置为 `guide`，域名绑定
正式生产入口是 `https://guide.horsemd.yangsir.net/`。域名通过阿里云 DNS 的 CNAME 指向 Vercel，HTTPS 证书由 Vercel 自动签发和续期；HTTP 必须 308 跳转到 HTTPS。`guide/vercel.json` 使用 `npm run check` 作为构建命令，输出目录为 `.vitepress/dist`。部署后应同时验证首页、至少一个无扩展名内页、`robots.txt` 和 `sitemap.xml`。
