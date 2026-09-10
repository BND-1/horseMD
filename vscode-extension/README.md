# HorseMD Preview for VSCode

A warm Markdown preview extension porting HorseMD's signature themes and rendering
pipeline to Visual Studio Code.

## Features

* **6 HorseMD themes**: Warm Light / Warm Dark, plus four Morandi palettes (Sage,
  Rose, Mist, Dusk). Or follow VSCode's color theme automatically.
* **LaTeX math** ($E=mc^2$ and $\int f$) rendered with KaTeX.
* **Mermaid diagrams** rendered live from CDN.
* **Syntax-highlighted code blocks** with atom-one-dark tokens on a dark surface
  in every theme — matching HorseMD's look.
* **GFM tables, task lists, blockquotes, images** — full GitHub-Flavored Markdown.
* **Outline sidebar** with scroll spy — click headings to jump, current section
  highlighted on scroll.
* **Live update** — pre view refreshes as you type (150 ms debounce) and on
  external file saves.
* **Front matter** displayed as a metadata block above the document.
* **Content width presets** — compact / standard / wide / full.

## Commands

| Command                           | Keybinding                             |
| --------------------------------- | -------------------------------------- |
| HorseMD: Open Preview             | `Ctrl+Alt+V` / `Cmd+Alt+V`             |
| HorseMD: Open Preview to the Side | `Ctrl+Alt+Shift+V` / `Cmd+Alt+Shift+V` |
| HorseMD: Switch Theme             | —                                      |
| HorseMD: Toggle Outline           | `Ctrl+Alt+O` / `Cmd+Alt+O`             |

## Settings

```json
{
  "horsemdPreview.theme": "auto",
  "horsemdPreview.fontSize": 16,
  "horsemdPreview.contentWidth": "standard",
  "horsemdPreview.showOutline": true
}
```

## Architecture

The extension renders Markdown in the extension host (Node.js) using
`markdown-it` + KaTeX + highlight.js — all CommonJS, no bundler needed.
The webview is a thin display layer that injects theme CSS and lazy-loads
Mermaid from CDN. KaTeX CSS is also loaded from CDN.

````
extension host (Node.js)
  └─ markdown-it → HTML → webview.postMessage
                                           ↓
webview (browser)
  └─ inject CSS → display HTML → outline + scroll spy
  └─ lazy-load mermaid from CDN → render ```mermaid blocks
````

## License

MIT
