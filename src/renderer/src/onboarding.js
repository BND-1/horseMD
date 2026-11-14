// First-run onboarding document, shown as the first tab after install.
// Localized. Built around a clear H1→H2→H3 heading hierarchy so the Outline
// panel (the "导航条") demonstrates itself: open the doc, toggle the outline,
// and the whole structure is right there, click-to-jump, cursor-following.

const EN = `# Welcome to HorseMD 🐎

**HorseMD** is a warm, modern **Markdown editor** — a Typora alternative built
around one idea: *every file opens as a tab in the same window*, not a new app
instance. Browse a whole folder in the sidebar, flip between files in tabs, and
write in a clean WYSIWYG editor.

> This page is a quick tour. Edit it, or close the tab — you won't see it again
> on the next launch.

## The Outline panel

This document is written with a clear heading hierarchy so you can see the
**Outline** (the navigation bar) in action. Toggle it on the left and the whole
document's structure appears as a tree you can click.

### How to open it

- Click the **outline icon** in the left activity bar, or
- Press \`Ctrl+Shift+B\` to toggle the sidebar, then switch to the outline tab, or
- Press \`Ctrl+Shift+L\` to jump straight to the outline.

### What it does

- **Click any heading** to jump to it instantly.
- The current heading **highlights live as you scroll or move the caret** — the
  outline always knows where you are.
- On a long document, the outline keeps the active entry comfortably centered.

## Rich text, live as you type

A taste of what renders in place.

### Code, diagrams, math

\`\`\`python
def fibonacci(n):
    seq = [0, 1]
    while len(seq) < n:
        seq.append(seq[-1] + seq[-2])
    return seq[:n]
\`\`\`

Mermaid diagrams render under the source — *Edit code* to tweak, *Hide code* to
view only the picture:

\`\`\`mermaid
flowchart LR
    A[Idea] --> B[Draft]
    B --> C{Good?}
    C -- yes --> D[Publish]
\`\`\`

Math via LaTeX: $E = mc^2$, or a display block:

$$\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

### Highlights, tables, review marks

Wrap text in \`==\` to mark it: ==important== and ==worth a second look==. Select
text and use the highlighter button for **yellow / red / blue**.

| Feature | Try it |
| --- | --- |
| Tables | edit any cell |
| Task lists | - [ ] click me |

Review marks annotate a draft while keeping the source readable:

- Addition: {++new text++}
- Substitution: {~~old word~>new word~~}

## Everyday essentials

- **Tabs** — many files in one window (\`Ctrl+Tab\` to cycle)
- **Folder workspace** — file tree on the left; create / rename / delete in place
- **Command palette** (\`Ctrl+P\`) — fuzzy-jump to any file or command
- **Layout** — font size, line height, paragraph spacing, page width from the
  status bar's *Layout* button
- **Find & replace** — \`Ctrl+F\` in the document
- **Themes** — Warm Light/Dark plus three **Morandi** palettes

### Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New / Open / Save | \`Ctrl+N\` / \`Ctrl+O\` / \`Ctrl+S\` |
| Command palette | \`Ctrl+P\` |
| Find | \`Ctrl+F\` |
| Sidebar / Outline | \`Ctrl+Shift+B\` / \`Ctrl+Shift+L\` |
| Source mode | \`Ctrl+/\` |
| Headings | \`Ctrl+1\`…\`Ctrl+6\` (\`Ctrl+0\` → text) |
| Cycle theme | \`Ctrl+Shift+T\` |

Happy writing! ✨
`

const ZH = `# 欢迎使用 HorseMD 🐎

**HorseMD** 是一款温暖、现代的 **Markdown 编辑器** —— Typora 的替代品。核心理念
只有一个：*每个文件都在同一个窗口里作为标签页打开*，而不是新开一个程序。在侧边栏
浏览整个文件夹，用标签页切换文件，在干净的所见即所得编辑器里写作。

> 这一页是一份快速导览。你可以编辑它，或者直接关掉 —— 下次启动不会再出现。

## 大纲面板（导航条）

这篇文档特意用了清晰的标题层级（一级、二级、三级），好让你直接看到 **大纲面板**
的效果：打开左侧的大纲，整篇文档的结构就以树状呈现，一目了然。

### 如何打开大纲

- 点左侧活动栏的 **大纲图标**，或
- 按 \`Ctrl+Shift+B\` 打开侧边栏，再切到「大纲」标签，或
- 直接按 \`Ctrl+Shift+L\` 跳到大纲。

### 大纲能做什么

- **点击任意标题**，瞬间跳到该位置。
- 滚动或移动光标时，当前所在标题会**实时高亮** —— 大纲始终知道你在哪。
- 文档很长时，大纲会让当前条目舒服地停在面板中部。

## 富文本，边写边渲染

下面这些都是在原地实时渲染的效果。

### 代码、图表、公式

\`\`\`python
def fibonacci(n):
    seq = [0, 1]
    while len(seq) < n:
        seq.append(seq[-1] + seq[-2])
    return seq[:n]
\`\`\`

Mermaid 图表在源码下方实时渲染 —— 点「编辑代码」可改，点「隐藏代码」只看图：

\`\`\`mermaid
flowchart LR
    A[想法] --> B[草稿]
    B --> C{满意?}
    C -- 是 --> D[发布]
\`\`\`

数学公式用 LaTeX 写：质能方程 $E = mc^2$，或块级公式：

$$\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

### 高亮、表格、审阅标记

用 \`==\` 包住文字即可高亮：这是==重点内容==，==值得再看一眼==。选中文字点高亮笔，
还能选 **黄 / 红 / 蓝** 三种颜色。

| 功能 | 试试看 |
| --- | --- |
| 表格 | 双击任意单元格编辑 |
| 任务清单 | - [ ] 点我 |

审阅标记能在草稿上批注，同时保持源码可读：

- 新增：{++新增的文字++}
- 替换：{~~旧词~>新词~~}

## 日常要点

- **标签页** —— 多个文件在一个窗口里打开（\`Ctrl+Tab\` 循环切换）
- **文件夹工作区** —— 左侧文件树，可原地新建 / 重命名 / 删除
- **命令面板**（\`Ctrl+P\`）—— 模糊跳转到任意文件或命令
- **排版** —— 状态栏「排版」按钮可调字号、行间距、段落间距、页宽
- **查找替换** —— 文档内 \`Ctrl+F\`
- **多套主题** —— 暖光 / 暖夜，外加三套**莫兰迪**配色

### 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 新建 / 打开 / 保存 | \`Ctrl+N\` / \`Ctrl+O\` / \`Ctrl+S\` |
| 命令面板 | \`Ctrl+P\` |
| 查找 | \`Ctrl+F\` |
| 侧边栏 / 大纲 | \`Ctrl+Shift+B\` / \`Ctrl+Shift+L\` |
| 源码模式 | \`Ctrl+/\` |
| 标题层级 | \`Ctrl+1\`…\`Ctrl+6\`（\`Ctrl+0\` 转正文） |
| 切换主题 | \`Ctrl+Shift+T\` |

祝写作愉快！✨
`

// Phones and tablets get their own tour: the desktop one talks about the
// activity bar and keyboard shortcuts. One paragraph per line — a line break
// inside a paragraph shows as a break in the editor.
const MOBILE_EN = `# Welcome to HorseMD 🐎

**HorseMD** is a warm, modern **Markdown editor**. Type Markdown and it renders right where you write — no preview pane.

> This page is a quick tour. Edit it, or close it with the ✕ on its tab — you won't see it again.

## Getting around

- **☰** (top left) opens the drawer: Home, your files and the outline of this document.
- **Tabs** keep several documents open. Tap one to switch, ✕ to close.
- **+** makes a new document, **⌘** searches files and commands.
- The **lock** turns on reading mode: scroll, select and copy without accidental edits. Tap it again to edit.
- **⋯ More** (bottom right) has Save, Source mode, themes and language.
- **Export** (bottom right) sends the document to Files, Mail or any other app.

## Write as you read

Start a line with \`# \` for a heading, \`- \` for a list or \`> \` for a quote.

### Code, diagrams, math

\`\`\`python
def greet(name):
    return f"Hello, {name}!"
\`\`\`

\`\`\`mermaid
flowchart LR
    A[Idea] --> B[Draft]
    B --> C[Publish]
\`\`\`

An inline formula $E = mc^2$, or a block:

$$\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

### Highlights, tables, tasks

Wrap text in \`==\` to ==highlight it==.

| Feature | Try it |
| --- | --- |
| Table | Tap a cell to edit |
| Task | Tap the box below |

- [ ] Write something
- [x] Open HorseMD

## Your files

- **Save** from ⋯ More. A new document asks for a name first.
- On iPhone and iPad, documents are in the **Files** app → On My iPhone → HorseMD.
- Share a \`.md\` file from Files or another app to open it here.

Happy writing! ✨
`

const MOBILE_ZH = `# 欢迎使用 HorseMD 🐎

**HorseMD** 是一款温暖、现代的 **Markdown 编辑器**。输入 Markdown，当场渲染成你要的样子，不用切预览。

> 这一页是快速导览。可以直接改它，也可以点标签上的 ✕ 关掉，以后不会再出现。

## 认识界面

- 左上角 **☰** 打开抽屉：主页、文件列表、本文的大纲。
- **标签页**：几个文档同时开着，点标签切换，点 ✕ 关闭。
- **+** 新建文档，**⌘** 搜索文件和命令。
- **锁**：阅读锁定，只能滚动、选择、复制，不会误触改动；再点一下恢复编辑。
- 右下角 **⋯ 更多**：保存、源码模式、主题、语言。
- 右下角 **导出**：把文档存到「文件」，或发到邮件、聊天等其他 App。

## 边写边渲染

行首输入 \`# \` 是标题，\`- \` 是列表，\`> \` 是引用。

### 代码、图表、公式

\`\`\`python
def greet(name):
    return f"你好，{name}！"
\`\`\`

\`\`\`mermaid
flowchart LR
    A[想法] --> B[草稿]
    B --> C[发布]
\`\`\`

行内公式 $E = mc^2$，或者块级公式：

$$\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

### 高亮、表格、任务

用 \`==\` 包住文字就是==高亮==。

| 功能 | 试试看 |
| --- | --- |
| 表格 | 点单元格直接改 |
| 任务 | 点下面的方框 |

- [ ] 写点什么
- [x] 打开 HorseMD

## 文件在哪

- **⋯ 更多 → 保存**。新文档会先让你起个名字。
- iPhone 和 iPad 上，文档在「文件」App → 我的 iPhone → HorseMD。
- 在「文件」或别的 App 里分享 \`.md\`，可以直接用 HorseMD 打开。

祝写作愉快！✨
`

export function welcomeDoc(lang, { mobile = false } = {}) {
  const zh = lang === 'zh'
  return {
    title: zh ? '欢迎使用 HorseMD.md' : 'Welcome to HorseMD.md',
    content: mobile ? (zh ? MOBILE_ZH : MOBILE_EN) : (zh ? ZH : EN)
  }
}
