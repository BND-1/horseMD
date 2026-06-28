# CLAUDE.md

Guidance for Claude / AI agents (and new devs) working in this repo. Keep it
short; deep detail lives in [`docs/`](./docs/).

## What this is

**HorseMD** — a warm, Typora-style Markdown editor. Electron shell + Vite +
React, with **Milkdown Crepe** (ProseMirror-based WYSIWYG) as the editor engine.
Core idea: every file opens as a **tab in one window**, not a new process. The
shell (tabs, file tree, command palette, outline, themes, i18n, welcome screen)
is all hand-written.

## Commands

```bash
npm install            # if Electron download is slow: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev            # electron-vite dev (HMR)
npm run build          # build main + preload + renderer → out/
npm start              # run the built app
npm run dist           # build + electron-builder package for the HOST platform
npm run dist:dir       # unpacked build (no installer)
```

`npm run dist` packages for whatever OS you run it on — **Windows NSIS** on
Windows, **macOS dmg + zip** on macOS (a dmg must be built on macOS). If the
electron-builder binaries download slowly:
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.

Builds are **unsigned**: Windows shows SmartScreen ("更多信息 → 仍要运行");
macOS Gatekeeper blocks first launch (right-click → Open, or
`xattr -dr com.apple.quarantine /Applications/HorseMD.app`).

## Layout

```
src/main/index.js      main process: window, IPC (fs/dialog/watch), menu, file watching
src/preload/index.js   contextBridge → window.api (whitelisted IPC)
src/renderer/src/
  App.jsx              shell: tabs, state, session, split, theme, lang, editor routing
  components/Editor.jsx  Crepe wrapper + block controls + enhancements
  components/{Sidebar,Tabs,Outline,CommandPalette,StatusBar,icons}.jsx
  components/LayoutControl.jsx  the "排版" popover (font size · line height · paragraph spacing · page width)
  components/SaveFab.jsx       floating Save button (shown only while the active tab is dirty)
  components/{Welcome,WindowControls,UpdateToast,RenameModal,ImageHostButton}.jsx  leaf views split out of App
  components/editor-{html,images,copy,highlight,mermaid,tablebreak}.js  Editor helpers: HTML node view · img paths · rich-copy · ==highlight== mark · mermaid preview · table-cell <br>
  hooks/usePopover.js   shared button→popover hook (closes on outside click / Esc)
  {paths,find,ui,settings,customThemes}.js  pure helpers: session · find · toast · prefs (page width / font / line height / paragraph spacing / image host) · custom-theme injection
  {blocks,themes,i18n,onboarding}.{js,jsx}
  styles/app.css       all styles + theme variables
build/                 icon.ico (Windows) + icon.icns (macOS) + installer.nsh (NSIS uninstall: keep user files)
scripts/               CDP-based e2e helpers (etv.mjs, inspect.mjs)
docs/                  architecture / features / implementation-notes / development
```

## Conventions & rules

- **Cross-platform — do not break the other OS.** This app ships on Windows and
  macOS from one codebase. Platform-specific code is gated:
  - main process: `process.platform === 'darwin' | 'win32'`
  - renderer: `window.api.platform` → an `.app.is-win` / `.app.is-mac` class on
    the root; write platform CSS under those selectors only.
  - title bar: `hiddenInset` + `trafficLightPosition` on macOS (top bar spans
    full width, activity bar drops below the traffic lights). On Windows the
    native `titleBarOverlay` is **disabled** — the renderer draws its own
    minimize/maximize/close buttons (`WindowControls` in `App.jsx`, gated to
    `platform === 'win32'`), driven by `window:*` IPC; main pushes
    `window:maximized` on `maximize`/`unmaximize` so the restore icon stays in
    sync. Keep both paths working when touching the top bar, and always leave a
    draggable area even when tabs fill the strip.
  - shortcuts accept both `Ctrl` and `Cmd` (`metaKey`).
  - launch args: `extractArgs()` in `main/index.js` splits argv into markdown
    **files** (→ `open-paths`, tabs) and **folders** (→ `open-folder`, workspace
    — from the Explorer "Open with HorseMD" folder entry). Keep both handled.
- **Markdown vs plain text.** Supported extensions are centralized:
  `MD_EXTS`/`MD_RE` in `main/index.js` (open dialog + folder scan), and
  `MD_DOC_RE` in `App.jsx`. `.md/.markdown/.mdx` open in the Crepe rich editor;
  `.txt` (and any other file with a path) opens in the **plain textarea** —
  feeding plain text through Milkdown collapses line breaks and hangs on large
  files. New untitled tabs (no path) use the rich editor. **Heavy docs**
  (> 50 K lines, > 400 K chars, or > 150 consecutive non-blank lines — see
  `isHeavyDoc` in `paths.js`) also default to the textarea; the user can opt
  into rich per-tab via the banner button. See
  [`docs/performance-large-doc.md`](./docs/performance-large-doc.md) for the
  full analysis and remaining P1/P2 optimization options.
- **ProseMirror view**: get it via `crepe.editor.ctx.get(editorViewCtx)` —
  `crepe.editor.view` is `undefined` in this Milkdown version.
- **Crepe content callback**: register `crepe.on(markdownUpdated)` **before**
  `crepe.create()`, or changes never fire (saves would write stale content).
- **Lazy-mounted editors**: a rich tab's `<Editor>` is created only on its first
  activation, then kept mounted (`mountedIds` in `App.jsx`). This keeps startup /
  session-restore fast (restoring N tabs spins up one editor, not N). Code that
  needs a tab's editor API (`editorApis[id]`) must activate the tab first — see
  `exportPathToPdf`, which opens/activates then waits for `getDocHTML`.
- **Raw HTML rendering**: Milkdown's `html` node shows markup as escaped text;
  we add a ProseMirror node view (`renderHtmlNodeView` in `Editor.jsx`) that
  renders recognized block HTML (e.g. `<table>`) as real, sanitized DOM.
  Display-only — the node round-trips through `attrs.value`, so the saved Markdown
  keeps the original HTML. **Register it by appending to `nodeViewCtx`**
  (`ctx.update(nodeViewCtx, v => [...v, ['html', …]])`), NOT by setting
  `editorViewOptionsCtx.nodeViews` — the core spreads `editorViewOptionsCtx` last
  into the EditorView, so the latter would overwrite every component node view
  (image-block captions, CodeMirror, tables, list items). Same channel Milkdown's
  `$view` uses; see [implementation-notes.md](./docs/implementation-notes.md).
- **Closing the window** warns about unsaved changes: main defers `close`
  (`allowClose` guard) and sends `app-close-request`; the renderer checks dirty
  tabs and calls `confirmAppClose()` to let it close. Covers the macOS traffic
  light, the Windows close button, and Cmd/Ctrl+Q (closing a tab is separate, in
  `closeTab`).
- **App version** is injected at build time via Vite `define` (`__APP_VERSION__`
  in `electron.vite.config.mjs`, from `package.json`); shown on the welcome page.
- **Split view**: `splitId` in `App.jsx` is the tab shown in the right pane
  (`split` is the live derived flag: right tab exists, differs from `activeId`,
  not on Home). The two panes are **flex siblings inside `.editor-area`** (a flex
  row) — visibility is driven by per-tab `display`/`order`, NOT by re-parenting,
  so toggling split never re-creates an editor (no Crepe re-parse). `editorHostRef`
  stays on the left/active pane (find, outline, scroll-ratio target it);
  `focusedTabRef` tracks the last-focused pane so Save/Export hit the pane you're
  editing. The right pane never shows global source mode.
- **Custom themes (Typora-compatible)**: user `.css` lives in `userData/themes`
  (scanned **recursively** — Typora themes ship as a folder); `themes:read` rewrites
  relative `url(...)` to absolute `file://` so theme fonts/images load. The CSS is
  injected via `customThemes.js` into one `<style>`; the editor content carries
  Typora's `#write` + `markdown-body` hooks so its selectors match. While a custom
  theme is active (`body.hm-has-custom-theme`) app.css yields the writing area's
  background/width AND sets content text `color: inherit` so the theme's colors win;
  the app chrome keeps its own styling. `applyTheme` preserves `hm-*` body classes.
- **Mermaid** (`editor-mermaid.js`): rendered through Crepe's **built-in code-block
  "preview" mechanism** (the same one LaTeX-style blocks would use), via
  `codeBlockConfig.renderPreview` + `previewOnlyByDefault`. A ` ```mermaid ` block
  shows only the diagram by default; the code block's own toolbar gets a Hide/Edit
  toggle next to Copy. Mermaid is `import()`-ed lazily; `ensureRender` retries once
  on a flaky first render (the lazy import can race with Mermaid's init). Do NOT
  use a custom widget decoration for this — `previewToggleText` must be set on the
  **feature** config (`featureConfigs[CrepeFeature.CodeMirror]`), not
  `codeBlockConfig`, because the feature reads it to build the toggle button.
- **Highlight** (`editor-highlight.js`): `==text==` is a custom Milkdown mark
  (yellow), plus red/blue via toolbar color picker (round-trips as
  `<mark class="hm-hl-…">`). Built as `$markSchema` + a two-way remark plugin
  (`mdast-util-find-and-replace` on parse; a `highlight` stringify handler). A
  selection-toolbar color button applies it (`applyHighlightInView`); `Mod-Alt-H`
  toggles yellow. Register via `crepe.editor.use(highlightFeatures)` — the **array**
  form (editor.use keeps only its first arg), and `highlightAttr` /
  `toggleHighlightCommand` MUST be in that array or Crepe init throws
  ("Context … not found"). The inline-code `inclusive:false` fix uses the same
  `extendSchema` pattern; a belt-and-suspenders post-create override is applied too.
- **Inline HTML** (`editor-html.js`): Milkdown splits `<span>x</span>` into
  open/text/close atom nodes; `remarkMergeInlineHtml` coalesces a balanced
  open…close run into one html node so the node view can render it. Block tags →
  `hm-html-block`, safe inline tags → `hm-html-inline`, everything else → escaped
  text. Sanitized (scripts/styles/on* handlers stripped).
- **Layout settings** (`settings.js` + `LayoutControl.jsx`): font size, line
  height, paragraph spacing, and page width are CSS variables
  (`--editor-font-size` / `--editor-line-height` / `--editor-para-spacing` /
  `--editor-max-width`) applied live. The slider writes the var DIRECTLY during a
  drag (no React round-trip) and commits once on pointer-up, so reflowing the whole
  editor per tick stays smooth.
- **Save**: a floating FAB (`SaveFab.jsx`) appears at the bottom-right only while
  the active tab is dirty. `usePopover` (hooks/) is the shared close-on-outside
  hook for all popovers — don't hand-roll a per-component copy (a previous one
  missed the outside-click close).
- **Slash (`/`) menu** is localized through the **BlockEdit** feature config
  (`slashCommandConfig`), not a `SlashCommand` key (there is no such enum member).
- **Math**: enable `CrepeFeature.Latex` (off by default). Block math needs `$$` on
  their own lines. Long display math scrolls (`.katex-display { overflow-x:auto }`).
- **Table-cell line breaks** (`editor-tablebreak.js`): GFM cells are single-line,
  so a break must round-trip as `<br>`. A keymap inserts a hardbreak; a custom
  remark stringify `break` handler emits `<br>` **only inside `tableCell`** (else
  default); a remark transform parses inline `<br>` back to a break. Don't let a
  cell break serialize to a newline — it corrupts the table.
- **Image host** (`ImageHostButton` + `image:upload` IPC): a Typora-style custom
  command. Renderer reads the file bytes and calls main, which writes a temp file,
  runs `<command> "<file>"`, and returns the last http(s) URL it prints. Empty
  command ⇒ paste/drop isn't intercepted (no dead blob: URLs).
- **Unsaved scratch tabs persist**: the session stores untitled (pathless) tabs
  whose content is dirty under `untitled: [{title, content}]`, and the mount
  restore recreates them (with `savedContent: ''` so they stay marked unsaved).
  Saved files are still reopened from disk via `openPaths`. The onboarding/welcome
  doc is skipped if either `openPaths` or `untitled` is present.
- **State**: session is `localStorage["minimd.session.v1"]` (includes the selected
  `customTheme`); prefs (page width, image-host command) are
  `localStorage["horsemd.settings.v1"]` (`settings.js`); onboarding flag is
  `localStorage["horsemd.onboarded.v1"]`; dismissed update notice is
  `localStorage["horsemd.update.dismissed"]`. Themes are `body` classes
  (`light|dark` + optional `theme-*`), with custom themes as an injected `<style>`.
- **Find**: in-document find uses the **CSS Custom Highlight API**
  (`CSS.highlights` + `Highlight`), not `window.find` — it searches only the
  editor body (rich `view.dom` / source `<textarea>`), never UI text, and paints
  ranges without mutating the DOM. See the find helpers in `App.jsx`.
- **File watcher must stay crash-proof.** chokidar recursively watching a tree
  with permission-protected paths throws a flood of `EACCES`/`EAGAIN`/`EBUSY`
  that, left unhandled, `abort()`s the whole main process on launch. The trap:
  a **relative** workspace path like `"."` resolves against the process CWD, which
  is `/` under Finder/launchd → it watches `/dev`, `/System/Volumes`, … (works in
  `npm run dev` only because the shell's CWD is the repo). So `watch:start` only
  watches **absolute** paths and refuses restricted roots (`isRestrictedRoot`:
  `/`, `.`, `..`, relative, `/dev`, `/System/Volumes`, …), ignores system trees,
  sets `followSymlinks:false`, and every watcher has an `'error'` handler; the
  renderer drops a non-absolute restored workspace (`sanitizeWorkspace`); and a
  process-level `unhandledRejection`/`uncaughtException` guard in `main/index.js`
  is the final safety net. Don't remove these. Also: main-process network calls
  use Electron's `net.fetch` (Chromium stack), not Node's global `fetch` (its
  c-ares resolver can abort an unsigned app under launchd).
- **Don't commit `dist/` or `out/`** (gitignored). `build/icon.*` IS tracked.

## Testing

No unit tests. Verification is done by running the packaged app and observing
behavior (screenshots), plus the CDP e2e scripts in `scripts/` — see
[`docs/development.md`](./docs/development.md). On macOS, when scripting the dev
build, note that `osascript "tell application \"Electron\""` can launch the
generic `node_modules` Electron bundle (a name collision); prefer testing the
packaged **HorseMD.app**, which has a unique name and bundle id.

## When in doubt

Read the matching doc in `docs/` before changing a subsystem — many non-obvious
behaviors (editor data flow, drag regions, watcher echo suppression, the
title-bar layout) are documented there with their root causes.
