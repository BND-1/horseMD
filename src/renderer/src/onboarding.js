// First-run onboarding document, shown as the first tab after install.
// Localized; introduces what AIxiao is, its features, and how to use it.

const EN = `# Welcome to AIxiao 🐎

**AIxiao** is a warm, modern **Markdown editor** — a Typora alternative built
around one idea: *every file opens as a tab in the same window*, not a new app
instance. Browse a whole folder in the sidebar, flip between files in tabs, and
write in a clean WYSIWYG editor.

> This page is just here to say hello. Edit it, or close the tab — you won't see
> it again on the next launch.

## What you can do

- **WYSIWYG live preview** — type Markdown, see it render in place
- **Tabs** — open many files in one window (\`Ctrl+Tab\` to cycle)
- **Folder workspace** — a file tree on the left; create, rename, delete in place
- **Command palette** (\`Ctrl+P\`) — fuzzy-jump to any file or command
- **Outline panel** — click a heading to jump; it follows your edits live
- **Themes** — Warm Light/Dark plus three **Morandi** palettes
- **Languages** — switch between English and 中文 anytime (bottom-right)

## Editing essentials

- Slash command menu (\`/\`) for inserting blocks
- Tables, code blocks with highlighting, **LaTeX math**, images, task lists
- Select text to get a formatting toolbar — including an **H** button: hover it
  to turn the current block into H1 / H2 / H3 / paragraph
- Or use the keyboard: \`Ctrl+1\`…\`Ctrl+6\` for headings, \`Ctrl+0\` for text
- **Ctrl/Cmd + Click** a link to open it in your browser
- Relative-path images (\`./img/pic.png\`) just work
- External edits to an open file reload automatically

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New file | \`Ctrl+N\` |
| Open file / folder | \`Ctrl+O\` / \`Ctrl+Shift+O\` |
| Save / Save As | \`Ctrl+S\` / \`Ctrl+Shift+S\` |
| Command palette | \`Ctrl+P\` |
| Find in file | \`Ctrl+F\` |
| Toggle sidebar / outline | \`Ctrl+B\` / \`Ctrl+Shift+L\` |
| Toggle source mode | \`Ctrl+/\` |
| Cycle theme | \`Ctrl+Shift+T\` |

Happy writing! ✨
`

const ZH = `# 欢迎使用 AIxiao 🐎

**AIxiao** 是一款温暖、现代的 **Markdown 编辑器** —— 一个 Typora 的替代品，
核心理念只有一个：*每个文件都在同一个窗口里作为标签页打开*，而不是新开一个程序。
在侧边栏浏览整个文件夹，用标签页在文件之间切换，在干净的所见即所得编辑器里写作。

> 这一页只是用来打个招呼。你可以编辑它，或者直接关掉这个标签 —— 下次启动不会再出现。

## 你能做什么

- **所见即所得实时预览** —— 输入 Markdown，原地渲染
- **标签页** —— 多个文件在一个窗口里打开（\`Ctrl+Tab\` 循环切换）
- **文件夹工作区** —— 左侧文件树，可原地新建 / 重命名 / 删除
- **命令面板**（\`Ctrl+P\`）—— 模糊跳转到任意文件或命令
- **大纲面板** —— 点击标题跳转，并随你的编辑实时更新
- **多套主题** —— 暖光 / 暖夜，外加三套**莫兰迪**配色
- **多语言** —— 随时在英文和中文之间切换（右下角）

## 编辑要点

- 行首输入斜杠 \`/\` 调出块菜单插入各种内容
- 表格、带高亮的代码块、**LaTeX 公式**、图片、任务列表
- 选中文字会弹出格式工具条 —— 其中有个 **H** 按钮：悬浮它就能把当前段落
  变成 H1 / H2 / H3 / 正文
- 也可以用键盘：\`Ctrl+1\`…\`Ctrl+6\` 设标题，\`Ctrl+0\` 转正文
- 按住 **Ctrl/Cmd 点击**链接，用系统浏览器打开
- 相对路径图片（\`./img/pic.png\`）开箱即用
- 外部程序修改了正在打开的文件，会自动刷新

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 新建文件 | \`Ctrl+N\` |
| 打开文件 / 文件夹 | \`Ctrl+O\` / \`Ctrl+Shift+O\` |
| 保存 / 另存为 | \`Ctrl+S\` / \`Ctrl+Shift+S\` |
| 命令面板 | \`Ctrl+P\` |
| 文件内查找 | \`Ctrl+F\` |
| 切换侧边栏 / 大纲 | \`Ctrl+B\` / \`Ctrl+Shift+L\` |
| 切换源码模式 | \`Ctrl+/\` |
| 切换主题 | \`Ctrl+Shift+T\` |

祝写作愉快！✨
`

export function welcomeDoc(lang) {
  return {
    title: lang === 'zh' ? '欢迎使用 AIxiao.md' : 'Welcome to AIxiao.md',
    content: lang === 'zh' ? ZH : EN
  }
}
