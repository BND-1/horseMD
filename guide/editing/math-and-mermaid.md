---
title: 公式与 Mermaid
description: 使用 LaTeX 数学公式和 Mermaid 图表，并查看全屏预览。
---

# 公式与 Mermaid

<span class="version-badge">适用于 HorseMD v0.6.0</span>

## 数学公式

行内公式使用单个美元符号：

```md
质能方程是 $E = mc^2$。
```

独立公式使用成对的 `$$`：

```md
$$
f(x) = \int_{-\infty}^{\infty} \hat f(\xi)e^{2\pi i\xi x}\,d\xi
$$
```

HorseMD 使用 KaTeX 渲染。过宽公式会在自身区域横向滚动，不会撑破正文宽度。单行 `$$x^2$$` 也会被安全规范化为显示公式，但分行写法更容易在其他 Markdown 工具中兼容。输入 `$$` 后回车，或使用 `/math`，光标会留在公式源码中并允许连续输入；离开编辑后恢复紧凑预览，点击工具栏“编辑代码”可再次修改。

## Mermaid 图表

创建语言为 `mermaid` 的围栏代码块：

````md
```mermaid
flowchart LR
  A[打开文件] --> B[开始写作]
  B --> C[保存]
```
````

富文本模式默认显示渲染后的图表，并保留源代码编辑入口。点击图表会进入全屏灯箱；按住拖动可以平移，`Ctrl+滚轮` 可以在 0.2～10 倍之间缩放，按 Escape 或点击背景关闭。

Mermaid 语法错误时保留源码供修改，不会执行图表中的脚本。
