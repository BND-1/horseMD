# 空段落系统契约（Empty Paragraph Contract）

> 状态：生效（2026-08-06）。这是空段落状态跨「保真层 / 源映射 / 模式切换」
> 三层共用的唯一事实源。任何层的新改动必须先对照本契约，避免再出现
> 「修 A 冒 B」的相互拆台。

## 1. 不变式

1. **独立的 `<br />` 行（含 `> <br />`、`- <br />`、`3. <br />`）是编辑器内部
   占位，绝不是作者内容，任何路径都不得写进源码。** 行内 `text<br>text` 与
   表格单元格内的 `<br>` 是作者内容，必须保留。
2. **源码里空段落 = 空白行（块分隔符），不是块。** remark 解析源码不会为它
   产生 md 块；ProseMirror 里它是空 textblock。
3. 因此 **PM 块数可能多于 md 块数**（每个空段落多一个 PM 块）。任何按序数
   对齐 PM↔md 的逻辑都必须把「PM-only 空段落」当作间隙处理，绝不能漂移到
   下一块。
4. **失败即保守（fail-closed）**：任何无法置信的映射/写回都不得移动光标或
   改写源码。

## 2. 三层职责

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 保真层 | `markdown-source-preservation.js` + `lib/markdown-preservation/*` | 输出的源码永远不出现独立 `<br />`；空段落 → 空行/无 |
| 生成路径 | `generatedScratchMarkdown` | 新建文档同样剥离 `- <br />`、裸 `<br />`，尾部收敛为作者换行数 |
| 源映射 | `editor-source-map.js` | 空 PM textblock = 间隙：光标映射到前一块末尾 +1；反向把空行光标送回空段落 |
| 模式切换 | `useSourceModeSwitch.js` + App | 依赖源映射；契约：双向切换光标保持不动 |

## 3. 各层规则

### 3.1 保真层

- `preserveRichMarkdownSource` 的**出口后置条件**统一剥离独立 `<br />` 行
  （保留引用前缀 `>`），再按作者尾部换行数钳制。任何启发式路径出错都不会
  把占位符漏进源码。
- `preserveEmptiedParagraph`：段落文字被删光 → 源码删掉该段落文字、留空行；
  只要求变更区间内至少一个空段落占位（`.some`），全文其他空段落不影响；
  不要求全文可见流相等（`。* ` 之类行内结构会让可见流分叉，那是无关的）。
- 空列表项：`normalizeEmptyListItems` 把 `- <br />` 写成 `- `（保留 marker）。

### 3.2 生成路径（新建文档）

- `generatedScratchMarkdown` 顺序：`normalizeEmptyListItems` → 裸 `<br />`
  剥离 → 列表紧凑化 → 尾部收敛为单个 `\n`。
- 列表输入规则意图只在基线一致时应用（`pendingMarkdownInputIntent.canonical
  === canonicalMarkdownRef.current`），过期意图立即清除，防止旧快照重建错误块。

### 3.3 源映射（光标）

- `correspondingMdBlock`：PM 块为空 textblock 时返回 `{ gap, gapOffset }`。
- `gapOffset` = 前一个非空 PM 块对应的 md 块 `end + 1`；若之后紧跟另一块，
  钳制到该块 `start`。连续多个空段落共享同一 gap，**禁止递归互查**（只对
  非空邻居递归）。
- `pmPosToMarkdownOffset`：md 为 gap 时直接返回 `gapOffset`。
- `markdownOffsetToPmPos`：落在两块之间空白行的 raw offset → 送回该处空段落
  的 PM 内容位置。
- 已知边界：源码无法区分「两个相邻空段落」与「一个空段落」，两者共享同一
  空行；反向映射总是回到第一个空段落。这是 Markdown 本身的表达能力上限，
  不是 bug。

### 3.4 模式切换

- rich→source：调用 `markdownOffsetFromSelection()`（走 3.3）得到 raw offset，
  设置源码 textarea 光标。
- source→rich：`restoreMarkdownOffset(rawOffset)`（走 3.3）送回 PM 位置。
- 双向契约：光标所在块与块内偏移必须一致；空段落光标落在对应空行上。

## 4. 回归锁定

```bash
# 源映射：空段落 gap、连续空段落 gap、表格/代码/公式/图片原子
npm run test:source-map

# 模式切换：8 位置双向链 + 切回后立即输入
npm run test:mode-switch-raw-offset-ui

# 空段落保真：清空/空段落输入删光/引用块内/多次往返，无 <br />
npm run test:empty-paragraph-source-ui

# 组合交互：空段落 × 光标 × 双向切换 × 位置/后续结构 × 连续切换
npm run test:empty-paragraph-caret-ui

# 新建文档列表 marker + 空项
npm run test:list-marker-empty-source-ui
```

`test:empty-paragraph-caret-ui` 覆盖：中间空段落、尾部空段落、普通段落、
列表前/后、表格前、代码块后、标题起点、连续两个空段落、三次连续切换链。
任何新增的「PM-only 结构」（未来可能有其它无法进入源码的块）都要在
`editor-source-map.js` 的 gap 机制与 `test:source-map` 中同步覆盖。

## 5. 未来方向

`lib/step-source-mapper.js`（块表：PM 范围 ↔ raw 范围）是把三层统一成单一
对应模型的演进方向，已在真实引擎上逐字节验证核心流程；当前未接入同步层，
0.13.x 边界硬化继续作为保命网。详见 `live-preview-migration-plan.md` §7–8。
