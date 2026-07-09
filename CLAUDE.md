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
  components/LayoutControl.jsx  the "排版" popover (font size · line height · paragraph spacing · page width); uses the shared ui/AdjustGroup
  components/SaveFab.jsx       floating Save button (shown only while the active tab is dirty)
  components/SettingsView.jsx  full-tab Settings page (typography + live preview · spell-check · theme · language · image host · about)
  components/ui/{Toggle,AdjustGroup}.jsx  shared switch + segmented/slider adjuster (reused by SettingsView + LayoutControl)
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
- **Releases** (GitHub): tag = `vX.X.X`, title = **`HorseMD vX.X.X`** (all 14
  historical releases unified to this format 2026-07-04 — keep it consistent).
  Release notes: Chinese, start directly with content (no HorseMD intro),
  structured as ✨ 新功能 / 🐛 修复 / 📦 下载 + unsigned-warning + full-changelog link.
  Build full set: mac dmg+zip (arm64+x64) + win nsis --x64 (`CSC_IDENTITY_AUTO_DISCOVERY=false`).
  `gh release create` sometimes leaves a draft (proxy flakiness) — check + `gh release edit --draft=false` to publish.
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
- **Code-block eager mount** (`editor-codeblock-eager.js`, #25 root-fix): Milkdown's
  `CodeMirrorBlock` node view lazy-mounts its CodeMirror editor via an
  IntersectionObserver(200px) + 5s teardown — a plain placeholder while off-screen,
  the real editor only in view. The placeholder↔mounted height delta (~127px) is
  what scroll-anchoring can't absorb when the editor has a selection (Chromium
  disables `overflow-anchor` for a focused contenteditable w/ selection) → "scroll
  to a code block, stop, select → page jumps". We modify `CodeMirrorBlock`'s
  **prototype** (it's exported) to mount EAGERLY (`renderPlaceholder` →
  `initializeCodeMirror`) and NEVER tear down (`scheduleTeardown` → no-op),
  keeping the height stable so no delta exists. A nodeView override can't do this
  (`nodeViewCtx` adds views but can't override `$view`-registered component views;
  `editorViewOptionsCtx.nodeViews` overwrites ALL component views) — the prototype
  mod is the surgical fix. `destroy()` still cleans up directly, so no leak. If
  Milkdown adds a config flag / renames these methods, revisit.
- **Outline jump** (`useOutline.js` `jumpAndStabilize`): clicking an outline heading
  triggers a custom ease-out scroll animation (200–500ms, rAF-driven — NOT
  `behavior:'smooth'`, which is unpredictable on large docs + fights overflow-anchor),
  then polls every 200ms re-scrolling until the position stabilizes (async content
  like images/mermaid/CV keeps shifting scrollTop). `overflow-anchor` is temporarily
  disabled during the poll + restored when stable. `forcedActiveRef` overrides the
  scrollspy's active heading during the poll (the `tops` cache may be stale mid-settle).
  Large-doc chunked-load: `richLoading` gates the outline list (skeleton during load)
  + queues the jump until `richDocVersion` bumps.
- **Mode-switch caret + viewport** (`scrollAnchor.js` + `App.jsx`, #28/#41 —
  **FIXED v0.5.26, dual anchor**): toggling rich↔source preserves BOTH the caret
  AND the reading position (viewport top) with no drift, in both pure-viewing and
  while-editing, across plain text / links / code / lists / tables / images /
  headings. **The root insight:** reading position and caret are TWO INDEPENDENT
  user intents — capture and restore each on its own precise-snippet anchor.
  `toggleSource` captures both: a CARET anchor (`captureRichCaret`/
  `captureSourceCaret`) and a VIEWPORT anchor (`captureRichViewport`/
  `captureSourceViewport` = the ~24 visible chars at the scroll-area top, via
  `caretPositionFromPoint` + a TreeWalker fallback). The `[sourceMode]` effect
  restores CARET first (selection only — NO `scrollIntoView`; textarea uses
  `focus({preventScroll:true})`), then VIEWPORT (sets scrollTop to the viewport
  anchor's text). Because the two restores are independent operations (set
  selection, then set scrollTop), they CANNOT fight — which is what defeated the
  earlier attempts: #28's dual system fought (coarse heading/ratio scroll vs
  precise snippet caret), and v0.5.25's caret-only + `scrollIntoView` yanked the
  viewport to an off-screen caret while reading ("content drift"). **Caret
  anchor:** short textblocks (a table cell "九十五", a heading) use the FULL block
  text + caret offset within it (`$head.parent.textContent`, `headOffset =
  $head.pos - $head.start()`); long blocks use the ≤24-char before-caret window.
  Source capture detects a GFM table row (`/^\|.*\|\s*$/`) and anchors on the
  CURRENT cell (a row-prefix snippet "| … | 九" has pipes/spaces that don't exist
  in the rich rendering, so it never matched). Matching picks the occurrence
  NEAREST the expected position (`ratio*size` / `ratio*len`) — not `lastIndexOf`
  — so a short snippet like "九" no longer collides with the "九" in "九十分".
  Restore order per anchor: snippet → heading → ratio. **The VIEWPORT anchor is
  pure DOM (NOT ProseMirror)** — `captureRichViewport` reads the text node at the
  scroller top (`caretPositionFromPoint` + a TreeWalker fallback for when the top
  is an `<img>`), and `restoreRichViewport` finds that text in a concatenated
  buffer of ALL text nodes (with an index→node map) and aligns it to the top.
  Pure DOM is deliberate: on a large, image-dense doc (hundreds of remote `<img>`,
  100k+ chars) the PM doc ↔ DOM mapping drifts, but the DOM text itself is stable.
  The snippet crosses text-node boundaries (viewport-top prose is often split by
  inline code/link marks), so single-`nodeValue.includes` matching misses it —
  hence the buffer. If the full snippet isn't found (a re-render split a mark
  differently), it retries a half-length prefix (longer=precise, shorter=robust).
  **Multi-pass** (rAF + 90/220/450ms) because Crepe fills rich content async after
  remount; PLUS a settle-aware tail (re-applies every 300ms up to ~3s while
  `richLoading` OR `scrollHeight` is still changing — the latter catches the
  hundreds of remote `<img>` re-fetching/re-laying-out on the source→rich re-
  render — then one final pass once the height stabilizes). **Product behavior
  (deliberate):** the viewport-top anchor wins — if the caret was off-screen
  before the toggle (user scrolled away to read), it stays off-screen after; the
  caret is restored to its TEXT but NOT scrolled into view. This is what makes
  pure-viewing not drift. **Known limit:** `EditorArea.jsx` (~L85
  `usesTextarea = … || (sourceMode && isLeft)`) UNMOUNTS the Crepe and mounts the
  textarea on source toggle, so every toggle re-parses the whole doc + reloads
  its images; on an extreme doc (100k+ chars, 100s of remote images) that re-
  render is non-deterministic, so the viewport lands within ~0–2 lines (usually
  exact) rather than pixel-perfect. A full fix would keep Crepe mounted across
  the toggle (display:none, sync only on source edit) — a larger Editor refactor. **Key files:** `scrollAnchor.js`
  (`capture/restore Rich/Source Caret/Viewport`, `posAtText`/`nearestIndexOf`
  nearest-occurrence, `visibleOccurrences`, `stripMdForSnippet`,
  `parseSourceHeadings`, `scrollSourceToHeading`); `App.jsx` `toggleSource`
  (~L320, captures both anchors) + `[sourceMode]` effect (~L336, caret-then-
  viewport, multi-pass + richLoading tail) + `richLoadingRef`. **Key API:** PM
  `view.state.selection.head` (no `.main`); `$head.parent.textContent` for the
  textblock (NOT `$head.end()` — for a table cell it resolves to the whole
  table); `view.posAtDOM`/`view.domAtPos` for the viewport text↔DOM mapping;
  `editorHostRef.current` = `.editor-scroll` (the rich scroller), `sourceRef.current`
  = the textarea (the source scroller). **CDP gotcha:** N tabs = N mounted editors
  — `querySelector('.ProseMirror')` may hit a hidden one; filter by `offsetParent`.
  Repro harness: `scripts/test-drift-measure.mjs` (round-trips each content type,
  measures caret context + scrollTop before/after).
- **Outline in source mode** (`useOutline.js` + `scrollAnchor.parseSourceHeadings`,
  #40): the outline used to blank in source mode. Now the list is regex-parsed from
  the textarea (`parseSourceHeadings`, also used by `headingAtSourceTop` + the #41
  caret helpers — single shared regex, constructed fresh per call to avoid a
  stateful `g`-flag `lastIndex`), the scrollspy maps `scrollTop→char→nearest heading`,
  and `jumpToHeading` scrolls the textarea via `scrollSourceToHeading`. A textarea
  `input` listener (debounced) live-refreshes the list. Rich-mode paths are unchanged
  (all source branches are `if (sourceMode)`-gated; the `richLoading` guard became
  `!sourceMode && richLoading`, identical in rich mode).
- **Code-block Tab at cursor** (`editor-codeblock-tab.js`, #39): Crepe's code-mirror
  feature bundles `indentWithTab`, so Tab re-indented the whole line. Override =
  `Prec.highest(keymap.of([{key:'Tab',run:insertTabAtCursor}]))` injected via the
  `[CrepeFeature.CodeMirror]` featureConfig `extensions` field (the supported channel
  — the feature pushes `config.extensions` AFTER `indentWithTab`). **No prototype mod,
  no `editorViewOptionsCtx`/nodeView change** (those would clobber component node views).
  Shift-Tab (dedent) untouched; prose Tab unaffected (CM-scoped only).
- **Tab reorder** (`useFileOps.js` `reorderTabs`, #31): HTML5 drag in `Tabs.jsx`
  (draggable + onDragStart/Over/Drop/End). Close-button area cancels drag. Session
  persists tabs in array order (existing logic). Mobile skips draggable.
- **Show hidden files** (`settings.showHiddenFiles`, #29): main `showHidden` global +
  `settings:setShowHidden` IPC; `readTree`/`listFilesFlat` check it (always skip
  IGNORED_DIRS). App.jsx useEffect syncs + refreshes the tree.
- **Windows Ctrl+W** (#30): Win/Linux use a custom Window submenu (`close` binds
  `Alt+F4`, NOT `Ctrl+W`) instead of the bare `{ role:'windowMenu' }` whose injected
  `close` defaults to `CmdOrCtrl+W` (collides with Close Tab). mac keeps the bare role.
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
- **GFM autolink + non-ASCII** (`editor-autolink.js`): remark-gfm's
  autolink-literal extends a `www.`/`http://` URL across non-ASCII text (Chinese,
  full-width punctuation) because its terminator set is ASCII-only — so prose like
  `www.caixuetang.cn，中文…1` became ONE bogus link whose URL had raw non-ASCII
  chars, turning the sentence into a `[text](url)` visible in source mode.
  `remarkUnwrapNonAsciiAutolinks` (parse-side, appended to `remarkPluginsCtx` so it
  runs AFTER preset-gfm) replaces any link whose URL has non-ASCII chars with its
  own text children. Valid ASCII autolinks (`www.example.com`, `https://`) keep an
  ASCII URL → untouched. (Source mode then shows `www\.example.cn` — the `\.` is
  remark's standard escape that prevents re-autolinking on re-parse; renders as `.`.)
- **Layout settings** (`settings.js` + `LayoutControl.jsx`): font size, line
  height, paragraph spacing, and page width are CSS variables
  (`--editor-font-size` / `--editor-line-height` / `--editor-para-spacing` /
  `--editor-max-width`) applied live. The slider writes the var DIRECTLY during a
  drag (no React round-trip) and commits once on pointer-up, so reflowing the whole
  editor per tick stays smooth. `ui/AdjustGroup.jsx` is the shared control, reused by
  both `LayoutControl` (the StatusBar 排版 popover) and the Settings page.
- **Settings page** (`SettingsView.jsx`): a full-tab view opened from the
  ActivityBar gear (bottom-left) / mobile `•••` sheet. Tabs carry a `kind` field
  (`'doc'` default, `'settings'` for this page); `EditorArea` skips `kind!=='doc'`
  tabs and `App.jsx` renders `<SettingsView>` as a sibling. Settings tabs are
  transient — `useAppLifecycle` filters `kind!=='doc'` out of session persistence.
  StatusBar/SaveFab/saveTab gate on `kind!=='settings'` (no save on the page).
  StatusBar quick-controls (排版/主题/语言) stay — Settings is their full-version home.
- **Body font-size** (`.milkdown .ProseMirror p`): MUST set
  `font-size: var(--editor-font-size)`. Milkdown Crepe's `reset.css` hardcodes
  `.ProseMirror p { font-size: 16px }`; without the override the font-size slider
  only affects headings (which use `em`), not body paragraphs.
- **Spell-check** (`settings.spellcheck`, default OFF): applied as the `spellcheck`
  attribute on the Crepe `.ProseMirror` contenteditable in `Editor.jsx` (on mount +
  via effect). No IPC — the attribute is enough; all other surfaces opt out via
  `spellCheck={false}`.
- **Save**: a floating FAB (`SaveFab.jsx`) appears at the bottom-right only while
  the active tab is dirty. `usePopover` (hooks/) is the shared close-on-outside
  hook for all popovers — don't hand-roll a per-component copy (a previous one
  missed the outside-click close).
- **Slash (`/`) menu** is localized through the **BlockEdit** feature config
  (`slashCommandConfig`), not a `SlashCommand` key (there is no such enum member).
- **Math**: enable `CrepeFeature.Latex` (off by default). Block math needs `$$` on
  their own lines. Long display math scrolls (`.katex-display { overflow-x:auto }`).
  Inline math `$x^2$` converts only on the closing `$` (Milkdown input rule
  `/\$([^$]+)\$/`), so there's no preview while typing the content. `editor-math-preview.js`
  (#45) adds a live KaTeX tooltip near the caret while typing an unclosed `$<mathy>`
  span — purely additive (reads state + renders a floating div, no typing change),
  wired via `prosePluginsCtx` (the channel for raw ProseMirror plugins; `crepe.editor.use`
  is for Milkdown FEATURES and silently breaks init if you pass a raw `Plugin`).
  Hides on non-empty selection, code blocks, blur, and non-mathy content (`$5`).
- **Raw ProseMirror plugins** (keymaps, view plugins like the math preview) go into
  `prosePluginsCtx` (`ctx.update(prosePluginsCtx, (plugins) => [...plugins, yours])`),
  NOT `crepe.editor.use(...)`. `crepe.editor.use` is for Milkdown `$nodeSchema`/`$inputRule`/features
  (highlight, frontmatter, inlineCodeSchema); a raw `new Plugin({...})` passed there
  silently breaks Crepe init (editor never mounts, no error). See `tableBreakKeymap()`
  + `mathPreviewPlugin()` for the pattern.
- **Table-cell line breaks** (`editor-tablebreak.js`): GFM cells are single-line,
  so a break must round-trip as `<br>`. A keymap inserts a hardbreak; a custom
  remark stringify `break` handler emits `<br>` **only inside `tableCell`** (else
  default); a remark transform parses inline `<br>` back to a break. Don't let a
  cell break serialize to a newline — it corrupts the table.
- **Image host** (`ImageHostButton` + `image:upload` IPC): a Typora-style custom
  command. Renderer reads the file bytes and calls main, which writes a temp file,
  runs `<command> "<file>"`, and returns the last http(s) URL it prints. Empty
  command ⇒ paste/drop isn't intercepted (no dead blob: URLs). PicGo-Core
  (`picgo upload`) works directly as the command; the PicGo GUI app (no CLI) is
  reached by entering `picgo` (→ its local server `127.0.0.1:36677/upload`, #35).
  **Image-host URLs can be `http://`** (e.g. PicGo's `local-uploader` plugin returns
  `http://127.0.0.1:<port>/...`), so the renderer CSP (`src/renderer/index.html`)
  `img-src` MUST include `http:` — without it those images render as broken
  (CSP-blocked), which presents as "pasted image doesn't display" even though the
  upload succeeded.
- **Renderer CSP** (`src/renderer/index.html`, the `Content-Security-Policy` meta):
  `img-src 'self' data: https: http: blob:` — `http:` is intentional (local picbeds
  / http image hosts, Typora-compatible). `script-src 'self'` (no `'unsafe-inline'`)
  and `default-src 'self'` stay strict. There is NO main-process CSP header
  override, so this meta is the single source — don't regress `http:` from img-src.
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
- **Font settings (#38)**: `settings.fontWrite` / `settings.fontMono` (empty =
  default stack) are applied as inline CSS vars `--font-write` / `--font-mono` on
  the `.app` root div (so they beat `body.light/dark` AND the `.app.is-win`
  Consolas override). `fontStack(name, base)` in `settings.js` prepends the
  user font (quoted) to the default stack. The settings **preview** must
  explicitly use `var(--font-write)` (it inherits `body`'s `--font-ui` by
  default, which is the CHROME font, not the document font — without the override
  the preview silently ignores the document-font setting).
- **CodeMirror `--font-mono` fix**: CodeMirror's default theme hard-codes
  `.cm-content { font-family: monospace }`. Without an explicit override, the
  `--font-mono` CSS var NEVER reaches fenced code blocks — which is why #34's
  Windows Consolas override didn't fix curly quotes AND why a custom code font
  wouldn't apply. The rule `.milkdown .cm-editor .cm-content, .cm-line {
  font-family: var(--font-mono) }` (in app.css, specificity beats CM's default)
  is the root fix — don't remove it.
- **queryLocalFonts (Local Font Access API)**: the Settings font pickers
  enumerate installed system fonts via `window.queryLocalFonts()` on first
  focus/click (needs a user gesture). Permission is granted in `main/index.js`
  via `session.defaultSession.setPermissionRequestHandler` + `setPermissionCheckHandler`
  (grant-all — safe for a local editor; Markdown content isn't executed as JS).
- **FontPicker** (inline in `SettingsView.jsx`): a button trigger showing the
  current font in its own glyph + a popover with a search box + scrollable list
  where each font is previewed in its own font. **Hover-preview**: `hoverFont`
  state in `App.jsx` temporarily overrides `settings.fontWrite/fontMono` while
  the cursor is over an option (cleared on leave/close/pick). Pinned footer at
  the dropdown bottom links to font sites (doc → foundertype.com, code →
  nerdfonts.com).
- **`useColDrag` hook** (`hooks/useColDrag.js`): shared horizontal-drag helper
  for the split-pane divider + the outline/file-tree resizer. Both used to
  hand-roll the same mousemove/mouseup + body-class dance. onStart returns state
  (e.g. mousedown x / start width) passed to onMove as 2nd arg.

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
