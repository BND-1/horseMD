# 既有 source/canonical 分叉导致局部安全编辑被全文 integrity gate 锁死

> 状态：RS-45 / RS-46 泛化总矩阵发现；0.13.90 真实文件 `123321.md` 稳定复现；修复归属版本：0.13.93
>
> 家族编号：RS-47
>
> 日期：2026-08-23

## 1. 现象

打开一个作者源码本来就与 Crepe canonical 存在稳定表示差异的旧文件，在文档末尾进行一个局部、可证明安全的新列表/正文编辑。保真 mapper 已生成正确 candidate，但切源码仍被统一 integrity gate 阻止并弹出“富文本与源码不一致”。

`test:family-matrix-ui` 在真实 `123321.md` 上最小复现：移动到文档末尾，Enter 后输入 `1. 家族验证...`。`preserveRichMarkdownSource()` 返回：

- `preserved: true`
- `reason: trailing-empty-block-filled`
- candidate 正确在作者源码末尾新增独立 ordered row

但 source mode 仍被锁定。

## 2. 首个结构证据

`123321.md` 的既有作者源码尾部包含顶层图片：

```markdown
2. 智能体：...
	1. 招标信息
	2. 我们自己的知识库信息
   3. 根据招标信息、组织知识库信息，形成一个标书demo...
![image.png](assets/image-20260811035152751.png)
```

Crepe live canonical 会把该图片序列化为前一个嵌套 ordered item 的缩进内容：

```markdown
2. 智能体：...

   1. 招标信息
   2. 我们自己的知识库信息
   3. 根据招标信息、组织知识库信息，形成一个标书demo...
      ![image.png](assets/image-20260811035152751.png)
```

这属于打开文件时就存在的 source/canonical 表示分叉。用户本次只在文档尾部新增：

```markdown
1. 家族验证...
```

source mapper 对本次 delta 的定位是正确的，但 `validateSourceCandidate()` 当前要求“candidate 全文 parse 后必须与当前 canonical 全文绝对等价”。旧图片分叉因此让任何后续局部编辑都失败，即使本次 delta 与旧分叉完全无关。

## 3. 根因

RS-42 引入的统一 semantic AST + raw list-slot 双证明解决了“helper 错误返回 preserved=true 仍静默提交”的问题，但 semantic 层只有**终态全文等价**这一种成功条件。

对于从作者源码解析出来就存在 serializer 表示差异的旧文件，这个条件过强：

1. 初始 source/canonical pair 本来就是受信打开基线；
2. 本次 mapper 只需要证明“从旧 source → candidate 的语义 transition”与“从旧 canonical → 新 canonical 的语义 transition”相同；
3. 旧分叉必须保持不扩大；
4. 新的列表槽位仍必须经过 strict list-slot fingerprint；
5. 不能因为旧分叉存在就直接信任 `preserved: true`。

## 4. 正确修复边界

引入受信 source/canonical integrity checkpoint：

- 打开文件完成首个 live canonical 建立时，记录原始作者 source + 对应 canonical 为初始受信 checkpoint；
- 普通候选仍优先要求全文 semantic AST 等价 + list-slot 双证明；
- 若全文 semantic 不等价，只允许在“旧 source/canonical 与 checkpoint 精确相同”的前提下比较本次 transition；
- source 侧 `checkpoint.source → candidate` 与 canonical 侧 `checkpoint.canonical → live canonical` 必须产生完全相同的归一化语义变更区间；
- strict list-slot proof 仍必须通过；
- 通过后原子推进 source、canonical 和 checkpoint；失败仍 fail closed；
- `committed-source-baseline` 只有与最近一次已验证 checkpoint 字节完全一致时才可复用，不能把任意现存分叉当成可信状态。

这不是放宽完整性保护，而是把证明从“终态必须绝对相等”扩展为“可信旧分叉 + 本次 delta 等价”。

## 5. 回归合同

至少覆盖：

- 旧 source/canonical 在前文存在结构表示差异，文末新增普通正文仍可切源码/保存/重开；
- 同一旧分叉文末新增 ordered、unordered、前导空格列表仍可提交；
- source/canonical 本次 transition 内容不一致时必须拒绝；
- source 在错误位置修改同样文本时不得仅因 transition 文本相同而绕过结构/list-slot 证明；
- 通过一次 divergence-aware transition 后，无编辑源码切换必须复用精确 checkpoint，不再次锁死；
- RS-42～RS-46 的错误编号、空项、层级、delimiter 与 nested sibling 反例继续 fail closed / 正确映射；
- `npm run test:family-matrix-ui` 真实文件矩阵最终全绿。
