# horse

A beautiful, modern **Markdown editor** — a Typora alternative built around one idea Typora gets wrong: **every file opens as a tab in the same window**, not a new app instance. Browse a whole folder in the sidebar, flip between files in tabs, and write in a clean WYSIWYG editor.

> 一个更好看、交互更舒服的 Typora 替代品。打开新的 `.md` 文件时不会再新开一个窗口 —— 它会作为标签页在同一个编辑器里打开，方便你查找、阅读和编辑多个 Markdown 文件。

## Features

**Editing (everything Typora has)**
- Seamless **WYSIWYG live preview** (powered by Milkdown / ProseMirror) — type Markdown, see it render in place
- Slash command menu (`/`) for inserting blocks
- Tables, code blocks with syntax highlighting, **LaTeX math**, images, task lists, blockquotes
- Selection toolbar, link tooltips, smart lists
- **Source mode** toggle (`Ctrl+/`) for raw Markdown

**Beyond Typora**
- **Tabs** — open many files in one window (`Ctrl+Tab` to cycle)
- **Folder workspace** with a file-tree sidebar; create / rename / delete / reveal files in place
- **Command palette** (`Ctrl+P`) — fuzzy-jump to any file or command
- **Outline panel** (`Ctrl+Shift+L`) — click a heading to jump
- **Open in the same window**: double-clicking a `.md` in Explorer adds a tab instead of launching a new instance (single-instance + file association)
- Live word / character count & reading time
- Polished **dark & light themes** (`Ctrl+Shift+T`)
- Session restore (reopens your folder + tabs)
- Auto-refreshing file tree (watches the folder for external changes)

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New file | `Ctrl+N` |
| Open file | `Ctrl+O` |
| Open folder | `Ctrl+Shift+O` |
| Save / Save As | `Ctrl+S` / `Ctrl+Shift+S` |
| Close tab | `Ctrl+W` |
| Command palette | `Ctrl+P` |
| Find in file | `Ctrl+F` |
| Toggle sidebar | `Ctrl+B` |
| Toggle outline | `Ctrl+Shift+L` |
| Toggle source mode | `Ctrl+/` |
| Toggle theme | `Ctrl+Shift+T` |
| Cycle tabs | `Ctrl+Tab` / `Ctrl+Shift+Tab` |

## Develop

```bash
npm install        # if Electron's binary download is blocked, set a mirror first:
                   #   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev        # hot-reload dev mode
npm run build      # bundle main + preload + renderer into out/
npm start          # run the built app
npm run dist       # package a Windows installer (electron-builder)
```

## Tech

Electron + Vite + React shell, with **Milkdown Crepe** as the editor engine. The shell (tabs, file tree, palette, outline, theming) is custom.
