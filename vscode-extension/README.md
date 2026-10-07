# HorseMD for VSCode

A warm WYSIWYG Markdown editor porting HorseMD's signature themes and Milkdown Crepe editing experience to Visual Studio Code. Opening a `.md` file directly opens the visual editor — no preview pane, no split view.

## Features

* **WYSIWYG editing** — Milkdown Crepe editor opens directly for `.md` / `.markdown` / `.mdx` files via the Custom Editor API.
* **6 HorseMD themes** — Warm Light / Warm Dark, plus four Morandi palettes (Sage, Rose, Mist, Dusk). Or follow VSCode's color theme automatically.
* **LaTeX math** (`$E=mc^2$` and `$$\int f$$`) rendered with KaTeX.
* **Syntax-highlighted code blocks** via CodeMirror.
* **GFM tables, task lists, blockquotes, images** — full GitHub-Flavored Markdown.
* **Outline sidebar** with scroll spy — click headings to jump, current section highlighted on scroll.
* **Live sync** — edits in the visual editor sync to the underlying TextDocument; external edits sync back.
* **Content width presets** — compact / standard / wide / full.
* **Fully local** — all editor assets (Crepe, KaTeX CSS, KaTeX fonts) are bundled in the extension. No CDN, no network required.

## Commands

| Command                  | Keybinding                        |
| ------------------------ | --------------------------------- |
| HorseMD: Switch Theme    | —                                 |
| HorseMD: Toggle Outline  | `Ctrl+Alt+O` / `Cmd+Alt+O`        |

## Settings

```json
{
  "horsemd.theme": "auto",
  "horsemd.fontSize": 16,
  "horsemd.contentWidth": "standard",
  "horsemd.showOutline": true,
  "horsemd.autoSave": false
}
```

## Architecture

The extension bundles Milkdown Crepe and KaTeX CSS locally using esbuild (no bundler at runtime). The webview receives a single `editor.js` (IIFE) and `editor.css`.

```
extension host (Node.js)
  └─ registerCustomEditorProvider → provide HTML + local resource URIs
                                          ↓
webview (browser)
  └─ load editor.js (local) → init Crepe → markdownUpdated event → postMessage edit
  └─ receive update messages from host → setMarkdown (external edits)
```

Content is passed via `postMessage`, not inline scripts — CSP allows only `script-src ${cspSource}` (no `unsafe-inline`, no `unsafe-eval`, no CDN).

## Build

```bash
cd vscode-extension
npm install
npm run build    # esbuild → media/editor.js + media/editor.css
```

## License

MIT
