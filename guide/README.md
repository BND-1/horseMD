# HorseMD 使用教程站

面向普通用户的中文图文教程，线上地址计划为
[guide.horsemd.yangsir.net](https://guide.horsemd.yangsir.net/)。开发者实现说明仍放在仓库根目录的
`docs/`，不要把内部架构和故障复盘直接混入用户教程。

## 本地运行

```bash
npm install
npm run dev
npm run check
```

也可以从仓库根目录执行：

```bash
npm run guide:dev
npm run guide:check
```

`npm run check` 会检查页面元数据、版本、内部链接、导航、公开资源、截图尺寸、截图引用和私人路径，然后执行 VitePress 静态构建。

## 目录

- `.vitepress/`：站点导航、搜索、主题和图片灯箱。
- `getting-started/`～`troubleshooting/`：用户教程正文。
- `public/images/vX.Y.Z/`：对应版本的真实应用截图。
- `public/downloads/`：用户可下载的示例工作区。
- `scripts/check-content.mjs`：内容和版本一致性检查。

教程维护与截图流程见 [`docs/user-guide-maintenance.md`](../docs/user-guide-maintenance.md)。
凡是用户可见功能变更，都要同步更新对应教程页；截图必须来自重新构建并安装后的当前版本应用，使用隔离 profile，不能出现私人路径或过期 UI。
