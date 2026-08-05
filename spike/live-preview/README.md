# HorseMD Live Preview Spike（Phase 1 可行性试验）

验证 Obsidian/Typora 式「源码即数据模型」在 CodeMirror 6 上的可行性。
独立原型，不碰现有 Crepe 编辑器。

## 运行

```bash
cd spike/live-preview
npm install
npm run dev        # 开发服务器（浏览器打开）
npm run build      # 产物在 dist/（file:// 可直开，base 已设 ./）
```

## 已验证（2026-08-05，无头 Electron + CDP 实测）

| 指标 | 结果 |
| --- | --- |
| Lezer Markdown 解析（12.8 万中文字符） | ~5.4ms / 次（远低于 16ms 帧预算） |
| 初始渲染（解析 + 装饰构建 + 首帧） | ~7–8ms |
| 输入延迟（每键全量重解析 + 装饰重建） | ~0.33–0.36ms/字符 |
| 装饰渲染（标题/粗体/列表/代码围栏） | 正常；CM6 视口虚拟化，128k 文档只渲染可见行 |
| Vite 构建 / file:// 直开 | 正常（`base: './'`） |

## 结论

方案可行：CM6 + Lezer 在中文字符、12.8 万字符规模、逐键全量重解析下的
性能均满足 Live Preview 需求，性能不是障碍。

## 尚未验证（Phase 2 前需决策/试验）

- 表格交互 widget（列宽/增删行列 vs 纯文本表格 —— 已倾向纯文本，见
  docs/live-preview-migration-plan.md）
- 代码块内编辑（CM-in-CM）
- 图片 widget 显示、任务框点击、Review 批注 decoration
- 移动端 Capacitor webview 输入法/滚动/长按
- 大文档 + 图片密集滚动体验
