# canonical 序列化转义清单（保真管道泄漏面审计）

> 状态：2026-08-09（HorseMD 0.13.26）全量审计。目的：把「富文本 ↔ 源码」保真管道所有序列化转义
> 形态、触发条件、处理路径一次列全，杜绝「用户踩一个、补一个」的零散打补丁。
> 更新：新增转义形态时必须先改这份清单，再改 `canonicalTextToSource`。

## 背景：为什么会有这类 bug

HorseMD 富文本（ProseMirror 文档）与源码（Markdown 字符串）是**两份独立表示**，
每次编辑由 `preserveRichMarkdownSource` 把 ProseMirror 文档差分翻译回源码。
而 Markdown 序列化器（remark-stringify / Crepe）为了保证「源码 → 重新解析 → 文档」
round-trip 语义不变，会对部分字符做转义。**canonical 是序列化视图，源码是作者视图**；
管道把 canonical 片段写回源码时若没有还原转义，用户的源文件就会出现作者没写过的
实体/反斜杠——这就是「空格变 `&#x20;`」「`~` 变 `\~`」「`-` 变 `*`」等一连串
用户抱怨的根因族。

## 转义形态全清单（实测结论）

| 形态 | 触发条件 | visible-map 处理 | 主路径(visible 一致) | 分歧回退 | scratch/new-doc | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `&#x20;` | 行首或需保语义的空格 | 解码为 1 可见字符 → **走主路径** | 行首用 `U+200B + space`，行中/行尾用 space | 同左 | 同左 | ✅ 0.13.22（Typora 语义） |
| `\~` | 波浪线（防 GFM 删除线 `~~`） | 按 2 字符 → **走分歧路径** | 不出现（分歧） | 已反转义 | 曾泄漏 → 已反转义 | ✅ 0.13.15 |
| `\*`、`\_`、`` \` ``、`\[`、`\]`、`\(`、`\)`、`\!`、`\+`、`\-`、`\#`、`\.`、`\>`、`\|`、`\{`、`\}` | 强调/代码/链接/列表边界字面量 | 按 2 字符 → 走分歧路径 | 不出现（分歧） | `unescapeCanonicalBlock` 已反转义 | 输入规则恢复作者 marker；稳定列表正文用语义视图 + raw 边界表；独立字面反引号行按完整 next line 与 ordinal 回写 | ✅ 0.13.26 扩展专项测试 |
| `\\` | 反斜杠本身 | 按 2 字符 → 走分歧路径 | 不出现 | 已反转义 | **泄漏**（`a\b` → `a\\b`） | ⚠️ 见下 |
| `&amp;` `&lt;` `&gt;` `&quot;` `&#39;` 等实体 | 实测 Crepe 默认**不转义** `&<>"'`（段中/行首均原样） | 解码为 1 可见字符 | 不出现（序列化不产生） | 已反转义 | 不出现 | ✅ 实测无泄漏 |
| `<br />` | 空段落占位（Crepe 内部） | — | 出口后置条件统一剥离 | 拒绝 | `withoutStandaloneEmptyBlockLines` 剥离 | ✅ 硬不变式 |
| 行尾 `  `（两空格） | 硬换行 | 属于可见流 | 源码拼写保留 | — | canonical 拼写 | ✅ |

## 各路径处理位置

1. **上下文感知翻译函数** `canonicalTextToSource`（`lib/markdown-preservation/core.js`）：
   所有 canonical → 源码文本翻译的汇聚点（`adaptCanonicalRegionToSource` 内部、
   scratch/new-document、exact-canonical baseline、列表 direct-join）。只在 Markdown
   文本上下文处理 `&#x20;`：首个可见字符使用 `U+200B + space`，行中/行尾使用普通
   空格；`\~`→`~`；fenced/inline code、HTML comment、
   HTML raw block 保持字面值。行内 HTML 与 code span 按**实际 token 边界**扫描：HTML
   元素/属性和反引号跨度内部不改，同行标签外的 `0\~9` 仍恢复为 `0~9`；双反引号代码
   中包含单反引号也不会被 run-count 奇偶误判。局部 replacement 只有在完整落入上述
   literal range 时才跳过反转义。仅凭 canonical 的四空格或 Tab 缩进不能判定 literal：
   列表续行和嵌套块本身就带结构缩进，作者继续输入的真实空格会紧跟其后序列化成
   `&#x20;`。0.13.21 修复了这里曾存在的整行跳过逻辑；否则普通顶格测试通过，但嵌套/
   续行上下文仍会把实体写进源码。真实代码块由 serializer 输出为 fenced code，局部
   作者 literal 则由源码区域上下文保护。0.13.22 进一步确认“全部改成普通空格”会让
   四空格重新解析为代码块，因此采用本机 Typora 实测的零宽哨兵；解析插件和 visible map
   都必须把该哨兵视为源码语法。详见 `leading-space-mode-switch-regression.md`。
2. **分歧回退** `unescapeCanonicalBlock`（`lib/markdown-preservation/regions.js`）：
   可见流分歧时反转义 `\X`（escapePunctuation 全集）+ 全部 HTML 实体，定位作者块
   并拼写替换文本。仅单 canonical 块 + 源码唯一出现时启用，否则 fail-closed。
3. **空段落不变式** `withoutStandaloneEmptyBlockLines`：`preserveRichMarkdownSource`
   出口强制剥离独立 `<br />` 占位。
4. **输入规则 marker 恢复** `restoreTypedBulletMarker` / `preserveGeneratedBulletMarkers`：
   列表 `-`/`*`/`+` 触发路径恢复作者 marker。generated-scratch 修改首个列表项时不能
   只按项目全文匹配；前后 marker 行数量稳定时，用 ordinal + indent + list kind 回退，
   防止 Crepe 默认 `*` 泄漏，同时禁止跨列表类型恢复。
5. **稳定列表正文中的歧义标记**（`lib/markdown-preservation/lists.js`）：
   `1.`、`1)`、`-`、`+`、`*` 出现在列表项正文时，serializer 可能为防止二次解析
   增加反斜杠。处理器构造去转义语义视图及 raw boundary map，只应用本次文字 delta；
   作者已经写入的转义不在 delta 内，不能被全局清理。专项见
   `list-item-literal-marker-escape-regression.md`。
6. **独立字面反引号行**（`lib/markdown-preservation/paragraphs.js`）：部分删除必须读取
   完整 next canonical line，不能把 zero-width `commonChange()` replacement 当成整行清空；
   重复行优先用同行 ordinal。空段落后零宽输入另由 `preserveOrdinalLineTextChange()`
   限定映射。专项见 `backtick-source-sync-lock-regression.md`。

## 结构性解析分歧：`- 1. 甲乙` → 嵌套有序列表（0.13.17–0.13.18 修复）

**机制**：remark 把 `- 1. 甲乙`（作者意图：一个列表项，文本 "1. 甲乙"）解析成
**嵌套有序列表**（`1. 甲`、`2. 乙`，自动编号）。canonical 序列化为
`* <br />\n\n  1. 甲\n  2. 乙\n\n* 丙丁`（外层空项 + 嵌套项）。canonical 的
`1. ` `2. ` 是列表标记（不计可见流），而 source 里 `1. ` 是内容文本（计入可见流）
——两条可见流从该行起永久分歧。**任何列表内编辑（Enter 拆分、填字、删项）都会让
所有局部映射失败并 fail-closed 回退旧源码，用户输入静默丢失**。用户文件里的
`- 1. 管理层（总经理）` 这类目录行正是触发源。

**修复**（`preserveDivergedNestedListChange`，`lists.js`，diverged 分支最优先）：
canonical 顶层列表块的**扁平项文本序列**（每行 marker 行去标记；`* <br />` 空外层
wrapper——后随更深缩进 marker 的空行——跳过；真实空嵌套项 `2. <br />` 保留为空项）
与 source 顶层列表项行**按序对齐**（宽松匹配去掉作者的字面编号文本 `1. `；Enter 拆分
场景 source 一行 ↔ canonical 多项用**拼接匹配**并记录行内偏移），再应用**项级 diff**
（文本修改 / 插入新行 `- <token> <文本>` / 删除行或行内文本 / 空项填字）。
这是结构级映射：Enter 拆分/新增项会在 source 中产生**独立顶层行**（`- 1. 甲` +
`- 2. 新乙`），而不是把文本拼回一行。必须在 `preserveLocallyAlignedTextChange`
之前执行（分歧文档里该映射器可能把零宽插入映射到错误位置产生损坏行）。

0.13.18 的第二轮修复还补齐了三类结构变化：Backspace 删除内层数字 marker 后，
canonical 会出现无 marker 缩进续行；继续提升外层 bullet 时只能替换 marker 前缀，
不能删除正文；canonical 内层列表块不能计入后续源码顶层列表的 ordinal。对应实现是
`token + text + indent` 项投影、`topLevelListBlocksInSourceOrder()` 和续行 raw offset。

延迟 `markdownUpdated` 还可能一次携带多个相邻 `- / + / *` 列表的填充、插入与删除。
`preserveBatchedListBlockChanges(requireMultiple: true)` 会在单列表快捷路径之前原子提交
至少两个已证明发生变化的顶层列表，避免只保留一个操作、把 marker 统一成 `-` 或把
紧凑列表改成松散列表。真实 65ms 逐键场景中，“先给 `-` 列表加项，再在 `+` 空项填字”
第二次 callback 已不再属于结构变化；`preserveStableListRowChanges` 因此只在 row/gap
skeleton 完全稳定时更新那个空项，禁止 empty-item helper 吞并后续 `*` 列表。强制 flush
若仍无法证明映射，会保留 pending 与 canonical baseline 并返回失败，源码切换/保存暂停，
绝不把旧源码当成已同步内容写回。

回归：纯函数（拆分、文本编辑、删项、追加、空项填字、数字 marker 删除、两层提升、
后续加粗列表 ordinal、跨块删除）+ UI `npm run test:nested-number-list-source-ui`、
`npm run test:diverged-list-structure-ui`、`npm run test:diverged-partial-delete-ui` 和
`npm run test:rich-source-chaos-ui`。完整报告见 `nested-list-sync-bug-handoff.md`。

**事故记录（0.13.18 早期实现）**：首版实现曾把「目录」标题损坏为「目123」——raw
偏移/at 基准算错（行偏移含 `- ` 标记、编号前缀长度未计入）导致替换区间落到标题。
后续修复（`contentStart`、编号前缀 at、span 拼接偏移、空项行匹配）已消除；用
干净内容 + 完整两步操作（删除项 + Enter 新增）验证 `## 目录` 不再损坏。**用户磁盘
上被早期版本保存损坏的 `## 目123` 需手动改回 `## 目录`**。

## 跨块删除兜底：分歧文档的整段删除（0.13.18 修复）

**机制**：分歧文档（`- 1. …` 等行导致全文档可见流分歧）里**跨多个 canonical 块
的纯删除**（拖选删除文档尾部、一次删多个列表树）会让单块映射（nested-list、
diverged-block）全部失败并 fail-closed 回退旧源码——删除静默消失、tab 不脏、
保存写旧内容、重开后删除的内容复活。这是「删除全部内容」（canonical 空 →
`document-emptied`）和「单块删除」（diverged-block）之间的**中间地带**。

**修复**（`preserveDivergedVisibleDelete`，`regions.js`，diverged 分支最后、
fail-closed 之前）：canonical 删除区间**前 24 个可见字符**在 source 可见流中
**唯一锚定**（要求唯一出现），删除起点 = 锚点后；删除终点 = 区间后锚点或文档
可见流末尾。**删除内容校验**：被删 raw 文本逐行去列表标记（`- `、`N. `）后的
可见文本必须与 canonical 删除区间可见文本一致，不一致 fail-closed。纯删除
限定（replacement 无可见文本）——替换/插入场景不适用，保持既有行为。

回归：纯函数 1 例（真实 canonical：删「复核。」项 + 尾部 `- ce` 项）+ UI
`npm run test:diverged-partial-delete-ui`（反馈.md 形态：从「复核」删到文档
末尾 → 切源码 → 保存 → 重开，删除不复活）。真实反馈.md 文件实测通过。

## 已知遗留（刻意不动，需独立方案）

- **`\\`（反斜杠）在 scratch 路径的转义**：新文档输入 `\` 切源码会看到 `\\`。
  不能简单反转义——**行尾 `\` 是硬换行语法**，反转义会改变语义（`\` + 换行 →
  `<br />`）。需要区分行尾/行中上下文，且与用户 LaTeX 输入（`\\` 常见）冲突，
  必须等「源码即数据模型」的 Live Preview 迁移或输入法级方案一并解决。
- 泛化「把 canonical 完全还原为作者拼写」不可能完美：ProseMirror 只存语义
  （1 个 `\`），不存拼写（`\` vs `\\`）。本清单只保证**语义一致 + 源码可读**，
  不承诺字节级还原序列化器引入的规范化。

## 变更流程（防止再犯）

1. 用户在真实文档发现新的转义泄漏 → 先复现并确认触发条件，**更新本清单**。
2. 判断形态安全边界（是否行首/行尾上下文敏感、是否可能改变重解析语义）。
3. 修改 `canonicalTextToSource` 或对应的上下文处理器，补纯函数用例 + UI 回归；列表正文、
   代码/反引号、HTML、LaTeX 不允许共用无上下文的全局替换。
4. 跑 `npm run test:markdown-preservation` + 相关 UI 回归全矩阵。列表字面标记追加
   `npm run test:list-item-literal-marker-source-ui`；反引号删除追加
   `npm run test:code-fence-delete-source-ui`。
