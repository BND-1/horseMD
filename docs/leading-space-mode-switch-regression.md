# 行首多空格导致源码乱码与模式切换失真（0.13.22）

## 用户现象

在富文本段落中先连续输入多个空格、再输入文字，切换到源码模式时可能出现：

- `&#x20;` 实体直接出现在源码；
- 新段落被拼到上一段末尾；
- 行尾增加一串非用户输入的空格；
- 富文本切到源码后展示旧快照或损坏快照，看起来像“卡住”；
- 保存、重开后继续使用错误源码。

这不是单一实体替换问题，而是“空白中间态、Markdown 语义、安全源码拼写、光标映射”
四条链路共同形成的家族回归。

## 真实 CGEvent 复现

测试从已有文档末尾开始，使用 macOS `.cghidEventTap` 逐键发送：

1. `Enter` 两次；
2. 空格键八次；
3. 逐字输入 `abc`；
4. 切换源码。

修复前真实 `markdownUpdated` 轨迹：

```text
<br /> + 2 spaces -> trailing-empty-block-filled
3 spaces          -> structural-line-change
4+ spaces         -> structural-line-change
first text        -> localized-change on already-corrupted source
```

第三个空格开始，generic structural mapper 把段落分隔符删除，源码从：

```md
# test

anchor
```

逐步损坏成近似：

```text
# test

anchor        abc
```

因此模式切换不是渲染慢，而是同步层已经把损坏结果当成成功事务并清除了 pending 标志。

## 为什么不能直接把 `&#x20;` 换成普通空格

CommonMark 会吞掉 1–3 个行首 ASCII 空格作为缩进，4 个以上则解析为 indented code。
所以 `&#x20;       abc` 直接改成八个普通空格，重新打开后会变成代码块，canonical/source
再次分叉。0.13.21 只解决“实体可见”，没有守住 Markdown 重解析语义，因此不是完整根因修复。

## Typora 对照

本机 Typora 使用同一真实 CGEvent 序列后，磁盘字节为：

```text
U+200B + 8 个 ASCII 空格 + abc
```

即先写一个不可见零宽空格哨兵，再保留作者输入的全部普通空格。源码界面不会显示 HTML
实体，而 Markdown parser 也不会把后续空格当成代码缩进。HorseMD 0.13.22 采用相同语义。

## 工程修复

### 1. 纯空格中间态不写源码

`preserveTrailingEmptyBlock()` 将尾部 whitespace-only canonical block 与 `<br />` 一样
视为尚未完成的空段落：仅推进 canonical baseline，源码保持不变。输入首个可见字符后，
再通过 `trailing-empty-block-filled` 一次性追加完整段落。

### 2. Markdown-safe 行首空格拼写

`canonicalTextToSource()` 只在 `&#x20;` 位于该块首个可见字符时写入：

```text
U+200B + 普通空格
```

行中、行尾的 `&#x20;` 仍恢复为普通空格，避免给既有分歧删除等路径增加哨兵。

### 3. 哨兵是源码语法，不是正文

- `remarkStripLeadingSpaceSentinel()` 在 Markdown 进入 ProseMirror 前剥离哨兵；
- `sourceVisibleIndex()` 和 snippet mapper 忽略哨兵；
- canonical 再次出现行首实体时，源码保真层恢复哨兵；
- 因此富文本内容、源码显示、保存字节和模式切换光标保持一致。

实现集中在：

- `lib/markdown-leading-space.js`；
- `lib/markdown-preservation/core.js`；
- `lib/markdown-preservation/paragraphs.js`；
- `mode-visible-map.js`；
- `components/editor-crepe-setup.js`。

## 回归保障

`npm run test:leading-space-entity-ui` 现在覆盖：

- 已有文档的新段落；
- 清空后重新输入；
- 真正空文件的 scratch 生命周期；
- 两次 Enter + 八次延迟空格 + 逐字文字的真实中间态；
- 连续两次富文本/源码往返；
- 光标保持在最后输入字符后；
- 保存磁盘与完整新进程重开。

纯函数还覆盖四空格、Tab、列表续行和逐个 whitespace-only canonical delta。最终使用
macOS CGEvent 再验：第一次与第二次源码快照、光标 offset、磁盘文件全部一致。

## 防止再犯

1. 不得把 serializer entity 当成单纯字符串美化问题；先验证重新解析语义。
2. 不得让 whitespace-only rich paragraph 进入 generic structural mapper。
3. 测试必须强制产生多个 `markdownUpdated`，不能只测被 debounce 合并后的最终状态。
4. 新增源码语法哨兵时，解析、序列化、visible map、caret map、保存重开必须一起验证。
5. 自动化通过后仍需用 `docs/macos-real-input-testing.md` 的 CGEvent 路径复核真实键盘时序。
