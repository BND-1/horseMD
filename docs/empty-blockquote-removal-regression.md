# 空引用删除后复活回归报告

> 状态：0.13.23 已修复，等待用户验收
>
> 家族编号：RS-23
>
> 日期：2026-08-08

## 1. 用户症状

在富文本模式中删除引用后，界面上已经没有引用块；切换到源码模式仍能看到一行 `>`。保存文件并重新打开后，空引用块又出现。

## 2. 稳定复现

初始源码：

```markdown
before

> quote

after
```

真实逐键操作：

1. 选中引用里的 `quote`，按一次 Backspace；
2. 富文本保留一个空 blockquote，源码正确变为 `>`；
3. 在空引用里再按一次 Backspace；
4. 富文本 DOM 中 `blockquote` 已彻底消失；
5. 切源码仍是 `before\n\n>\n\nafter\n`；
6. 保存重开后，`>` 再次被解析为空引用块。

修复前新增的纯函数测试和后台 Electron UI 测试均稳定失败，排除“只在用户机器偶发”的可能。

## 3. 根因

第一次删除文字后的状态是：

```text
作者源码：        before\n\n>\n\nafter\n
previous canonical: before\n\n> <br />\n\nafter\n
```

第二次 Backspace 后：

```text
next canonical: before\n\nafter\n
```

`>` 是 Markdown 结构标记，`<br />` 是 Crepe 的空 paragraph 占位，两者都不贡献可见字符。因此 previous、next 和 source 的 visible stream 全部是 `beforeafter`，变化起止落在同一个 visible index。

旧的 `preserveChangedLineRegion()` 依赖可见行定位。它无法定位只包含 `>` 的源码行，却返回了保留旧源码的结构结果；随后 canonical 基线被推进，系统误以为这次删除已经同步。源码里的 `>` 因而永久残留，保存和重开把它重新渲染成引用。

## 4. 修复原则

新增 `preserveRemovedEmptyBlockquote()`，只处理严格受限的 syntax-only 删除：

1. previous 变化区只能包含 `>` 前缀和可选 `<br />`；
2. previous 与 next 的 visible stream 必须相同，变化前后的 visible index 必须相同；
3. source 允许在文档其他位置与 canonical 分叉；使用边界前后各最多 24 个可见字符，在 source 中唯一定位局部 boundary；
4. 使用这个局部 boundary 的 backward/forward raw offset，取得相邻可见文本之间的完整源码 gap；
5. source gap 的非空行必须全部是纯 `>` 行；
6. 若相邻 gap 还包含未变化的标题等结构前缀，source / previous / next 的非引用行必须逐行一致；
7. source 空引用行数必须等于 previous，next 的空引用行数必须严格减少，因此也覆盖两个连续空引用删掉其中一个的 `2 → 1` 场景；
8. 用 next gap 局部替换 source gap，删除目标 `>` 及它拥有的块分隔，不触碰前后正文。

该处理器位于空段落和通用结构处理器之前。它不处理带可见文字的引用、不做全文 canonical 覆盖，也不扫描删除其他 `>`。

## 5. 修改文件

- `src/renderer/src/lib/markdown-preservation/paragraphs.js`
  - 新增 syntax-only empty blockquote removal mapper。
- `src/renderer/src/markdown-source-preservation.js`
  - 在通用结构映射前调用专用处理器。
- `scripts/test-markdown-source-preservation.mjs`
  - 固化真实 previous/source/next 三快照。
- `scripts/test-empty-blockquote-removal-ui.mjs`
  - 后台启动 Electron，真实执行两次 Backspace，验证源码、保存与完整重开。

## 6. 验收合同

```bash
node scripts/test-markdown-source-preservation.mjs
npm run test:empty-blockquote-removal-ui
npm run test:empty-paragraph-source-ui
npm run test:full-doc-delete-source-ui
npm run test:source-fidelity-ui
npm run test:mode-switch-raw-offset-ui
npm run build
```

必须同时满足：

- 第一次只清空引用文字时，源码保留空 `>`，不泄漏 `> <br />`；
- 第二次删除空引用结构时，源码 `>` 同步消失；
- 普通引用文字编辑仍保留引用 marker；
- 模式往返不恢复引用；
- 保存磁盘不含残留 `>`；
- 完整重开不再出现空引用。

## 7. 防回归结论

“可见内容没变”不等于“没有用户编辑”。列表 marker、引用 marker、空段落和块边界都可能是零可见字符的结构变化。以后新增结构语法时，必须同时验证 raw gap，而不能只依赖 visible diff。
