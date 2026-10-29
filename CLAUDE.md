# CLAUDE.md

Guidance for Claude / AI agents (and new devs) working in this repo. Keep it
short; deep detail lives in [`docs/`](./docs/).

> New AI handoff: read [`docs/ai-handoff.md`](./docs/ai-handoff.md) first. It
> captures the current project state, user working style, risk map, website/guide
> ownership, verification matrix, and recent stable baseline. This file remains
> the detailed historical convention book.

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
npm run guide:dev      # user tutorial site
npm run guide:check    # tutorial content checks + static build
```

`npm run dist` packages for whatever OS you run it on — **Windows NSIS** on
Windows, **macOS dmg + zip** on macOS, and **Linux amd64 deb + Arch pacman
(`.pkg.tar.xz`)** on Linux. Installers
must be built and validated on their target OS; a dmg must be built on macOS and
a deb must pass `dpkg-deb --info` on Linux. If the
electron-builder binaries download slowly:
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.

Builds are **unsigned**: Windows shows SmartScreen ("更多信息 → 仍要运行");
macOS Gatekeeper blocks first launch (right-click → Open, or
`xattr -dr com.apple.quarantine /Applications/HorseMD.app`). Linux users should
install only the `.deb` (or, on Arch, the `.pkg.tar.xz`) from the official
GitHub Release. Its postinst is our
`build/linux/after-install.tpl` (`deb.afterInstall`), which always installs
`chrome-sandbox` as `root:root 4755` — electron-builder's default probes
`unshare` as root and leaves it 0755, which crashes on launch under Ubuntu
24.04+'s AppArmor userns restriction (#143). `release.yml` asserts this. Packaging runs with `USE_HARD_LINKS=false`
(#157): on CI electron-builder hard-links copies of one source file, so
`resources/icons/32x32.png` became a hard link to the hicolor icon and dpkg
failed with "Invalid cross-device link" where `/opt` is its own mount
(deepin 25); `release.yml` rejects any hard link in the .deb / pacman
package. The Arch package (#153) reuses the same template
(`pacman.afterInstall`) and overrides `pacman.depends`: electron-builder's
default list names packages Arch no longer ships (`http-parser`,
`libappindicator-gtk3`), so `pacman -U` would fail. Keep the list to the
libraries the binary actually links. `release.yml` installs and launches it in
an `archlinux` container (`scripts/ci/verify-arch-package.sh`).

## Layout

```
src/main/index.js      main entry: window, menu, single-instance, launch args (extractArgs);
                       registers the IPC modules below + shell/themes/image/window/update/permissions IPC
src/main/documents.js  document/dialog IPC + PDF preview/save/dispose IPC registration
src/main/filesystem.js fs IPC (read/write/rename/delete/create/readDir/listFiles/duplicate) + showHidden
src/main/watchers.js   chokidar watchers (watch:start/stop/file/unfile) — crash-proof guards (isRestrictedRoot)
src/main/security.js   external-URL protocol allowlist (https/http/mailto) + local-fonts permission gating
src/main/pdf-export.js  cancellable preview sessions, resource wait, printToPDF, save
src/main/pdf-document.js pure PDF document/TOC/header/footer construction
src/main/pdf-print-styles.js isolated print stylesheet and pagination rules
src/main/pdf-images.js  stages local/remote images for isolated PDF printing
src/main/html-export.js   HTML Studio: preview token, image embed, precise save (latest-request-only)
src/main/html-document.js pure HTML template (themes/widths/CSP/TOC) — no Electron
src/main/pandoc-export.js Pandoc detect/select/export + save dialog + error mapping
src/main/pandoc-core.js   Pandoc format whitelist, version parse, args (pure)
src/main/subprocess.js    no-shell subprocess: timeout→kill→SIGKILL, 64 KiB stderr cap
src/main/export-prefs.js  per-file export save-dir remembering (userData/export-prefs.json)
src/main/globalsearch.js workspace search IPC (search:workspace): scans roots via listMarkdownFiles,
                       mtime-validated content cache, latest-request-only caps
src/main/globalsearch-core.js pure search logic (multi-term AND, occIdx aligned with find.js
                       matchIndices, snippet ranges, caps) — locked by scripts/test-global-search.mjs
src/main/ai/              AI Phase 0 pure logic: context-snapshot (sha256 revision) + change-proposal
src/preload/index.js   contextBridge → window.api (whitelisted IPC)
src/renderer/src/
  App.jsx              shell: tabs, state, session, split, theme, lang, editor routing
  components/Editor.jsx        lifecycle orchestrator (~600 lines): Crepe create/destroy,
                          onReady API, chunk-append, new-doc H1 init, lightbox + block-menu JSX.
                          (The heavy logic was split into the editor-* modules below — see
                          docs/editor-feature-inventory.md for the full map.)
  components/{Sidebar,Tabs,Outline,CommandPalette,StatusBar,icons}.jsx
  components/LayoutControl.jsx  the "排版" popover (font size · line height · paragraph spacing · page width); uses the shared ui/AdjustGroup
  components/SaveFab.jsx       floating Save button (shown only while the active tab is dirty)
  components/SettingsView.jsx  full-tab Settings page (typography + live preview · spell-check · theme · language · image host · about)
  components/ui/{Toggle,AdjustGroup}.jsx  shared switch + segmented/slider adjuster (reused by SettingsView + LayoutControl)
  components/{Welcome,WindowControls,UpdateToast,RenameModal,ImageHostButton}.jsx  leaf views split out of App
  components/editor-crepe-setup.js     Crepe featureConfigs + Milkdown ctx + remark/prose plugins + HTML/frontmatter node views + Mermaid/LaTeX/code-block/review/highlight/table-break wiring; neutralizes Crepe's built-in slash + wires the self-built one
  components/editor-slash-menu.js      Feishu-style slash menu: raw ProseMirror plugin (prosePluginsCtx) + SlashProvider; keyword filtering + keyboard nav (see "Slash menu" convention)
  components/editor-dom-bindings.js    ProseMirror DOM behavior: shortcuts, context menu, selection sync, rich-copy, image paste/drop + relative-path resolve, lightbox trigger, caption focus, code-block copy feedback, selection-toolbar scan, slash-menu bounds
  components/editor-api.js             onReady API surface: export markdown/html, review apply, replaceMarkdown, restoreMarkdownOffset, markdownOffsetFromSelection
  components/editor-pdf-content.js     structured PDF snapshot, Mermaid/LaTeX materialization, table measurement, editor-DOM cleanup
  components/editor-source-map.js      markdown raw-offset ↔ ProseMirror block-level mapping (the mode-switch caret anchor)
  components/editor-image-persistence.js  image paste/drop → local save / image-host / data-URL fallback
  components/editor-lightbox.js        image/Mermaid lightbox (Esc / Ctrl-wheel zoom / drag-pan)
  components/editor-criticmarkup-plugins.js  CriticMarkup substitution rebuild + IME compositionend + strike guard
  components/editor-review.js          review plugin state machine + command entry points
  components/editor-review-decorations.js  CriticMarkup scan + Decoration construction
  components/editor-review-card.js     review card DOM + edit/navigation actions
  components/editor-{html,images,copy,highlight,mermaid,tablebreak,math,math-preview,autolink,frontmatter,md-paste,toolbar,toolbar-autohide,block-controls,chunked-parse,codeblock-eager,codeblock-tab,source-caret,link-labels}.js  other Editor helpers
  components/GlobalSearchPanel.jsx  workspace search sidebar pane (third sidebarMode 'search', issue #120)
  hooks/useGlobalSearch.js   search state (debounce + stale-drop) + result-jump: source tabs land the
                          FindBar on the exact occurrence (occIdx), rich tabs restoreMarkdownOffset
                          then pick the nearest highlighted range
  hooks/useWorkspace.js multi-root workspace state + directory watchers
  hooks/useSidebarTree.js file-tree loading, expansion + active-file following
  hooks/useSourceModeSwitch.js per-tab source mode + rich/source sync + anchor restore
  hooks/usePopover.js   shared button→popover hook (closes on outside click / Esc)
  {paths,find,ui,settings,customThemes}.js  pure helpers: session · find · toast · prefs (page width / font / line height / paragraph spacing / image host) · custom-theme injection
  {blocks,themes,i18n,onboarding}.{js,jsx}
  styles/app.css       all styles + theme variables
build/                 icon.ico (Windows) + icon.icns (macOS) + icons/ PNG set (Linux) + installer.nsh
scripts/               CDP-based e2e helpers (etv.mjs, inspect.mjs)
docs/                  architecture / features / implementation-notes / development
guide/                 VitePress user tutorial + versioned current-app screenshots
```

## Conventions & rules

- **Cross-platform — do not break the other OS.** This app ships on Windows,
  macOS, and Linux from one codebase. Platform-specific code is gated:
  - main process: `process.platform === 'darwin' | 'win32' | 'linux'`
  - renderer: `window.api.platform` → an `.app.is-win` / `.app.is-mac` /
    `.app.is-linux` class on
    the root; write platform CSS under those selectors only.
  - title bar: `hiddenInset` + `trafficLightPosition` on macOS (top bar spans
    full width, activity bar drops below the traffic lights). On Windows the
    native `titleBarOverlay` is **disabled** — the renderer draws Windows or GTK
    minimize/maximize/close buttons (`WindowControls` in `Topbar.jsx`, gated to
    `platform === 'win32' || platform === 'linux'`), driven by `window:*` IPC; main pushes
    `window:maximized` on `maximize`/`unmaximize` so the restore icon stays in
    sync. Keep all three desktop paths working when touching the top bar, and always leave a
    draggable area even when tabs fill the strip.
  - shortcuts accept both `Ctrl` and `Cmd` (`metaKey`).
  - launch args: `extractArgs()` in `main/index.js` splits argv into markdown
    **files** (→ `open-paths`, tabs) and **folders** (→ `open-folder`, workspace
    — from the Explorer "Open with HorseMD" folder entry). Keep both handled.
- **Workspace** (`useWorkspace.js` + `useSidebarTree.js` + `Sidebar.jsx`): a SINGLE, UNNAMED
  workspace — just a bag of folder roots (`folderRoots: [abs,…]`, persisted in
  session). No name, no multi-workspace, no switching (one workspace is enough for
  a writing app; users add/remove folders within it). The sidebar head shows a
  FIXED「工作区」label (never the folder name); the file tree is **multi-root**
  (each `folderRoot` a synthetic top-level folder node reusing `renderNode`).
  "Open Folder…" (dialog, `Cmd/Ctrl+Shift+O`, or the Explorer folder launch)
  **adds** a folder — it does NOT replace; right-click a root node → "remove from
  workspace". `loadFolderRootsFromSession` migrates the prior multi-workspace
  shape (`workspaces:[{folderRoots}]`, merged) and the legacy single-`{workspace:
  {rootPath}}` shape losslessly. The watcher starts one `watch:start` per root
  (main's `watchers` Map is per-dir → reuses the crash-proof guards);
  `folderRoots.join('\n')` is the stable effect dep so the watcher/files effects
  don't re-run every render. Zero roots → sidebar shows an "add folder" empty
  state.
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
  `exportPathToPdf`, which opens/activates then waits for the per-tab editor API
  readiness signal before reading `getPdfSource()`.
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
  Main has the same define: in an unpackaged run (dev, tests)
  `app.getVersion()` is Electron's own version.
- **In-app update** (#164, `main/updater.js` + pure `main/update-core.js`,
  `UpdateToast.jsx`, `hooks/useUpdateDownload.js`): the prompt offers「直接下载」
  and「去 GitHub 查看」(Settings › About too). Main downloads only assets of the
  release it fetched itself (HTTPS; never a renderer URL) through net.request,
  with progress / background / cancel, and verifies SHA-256 — taken from
  GitHub only: the API's asset `digest`, else `SHA256SUMS.txt` from
  github.com (mismatch → deleted). Sources (`update-core.js`
  `downloadSources` / `rankSources`): GitHub + public mirrors (ghfast.top,
  gh-proxy.com) probed at once (Range, ≤ 512 KB / 5 s), fastest first,
  GitHub kept when ≥ 70 % of the best; a source that errors, sends nothing
  for 30 s or fails the checksum hands over to the next. Mirrors carry
  bytes only. Measured 2026-10-26: Windows PC in China — GitHub no answer
  in 5 s, gh-proxy chosen, 129 MB in 35 s; mini in the UK — GitHub chosen.
  The prompt says「经 <host> 加速」when a mirror is used.
  `HORSEMD_TEST_UPDATE_MIRRORS` replaces the mirror list in tests. Modes: Windows `install`
  (NSIS `--updated /S --force-run`, what electron-updater runs); macOS
  `install` (zip unpacked + Info.plist version checked; a detached script
  swaps `/Applications/HorseMD.app` after exit and opens it — Squirrel.Mac
  needs a signed app) or `open` (the dmg, when the bundle is not replaceable:
  read-only, /Volumes, AppTranslocation); Linux `reveal` (deb / pacman to
  Downloads — installing needs root). 「重启并安装」 quits through `quitApp`
  (the unsaved-changes confirm can cancel; `app:cancel-close` drops the
  pending install); the installer / script starts in `will-quit`. Refused when
  `!app.isPackaged`. `HORSEMD_TEST_UPDATE_FEED` points the feed at a local
  server (http://127.0.0.1 assets allowed then). Locked by `test:update-core`,
  `test:update-ui`; end-to-end checked on a packaged app (mini 2026-10-26:
  0.13.256 → 0.13.999 swapped and reopened).
- **Releases** (GitHub): tag = `vX.X.X`, title = **`HorseMD vX.X.X`** (all 14
  historical releases unified to this format 2026-07-04 — keep it consistent).
  Release notes: Chinese, start directly with content (no HorseMD intro),
  structured as ✨ 新功能 / 🐛 修复 / 📦 下载 + unsigned-warning + full-changelog link.
  Release versions must be monotonically greater than every build that may have
  been distributed for testing: do not publish a lower "clean" version after
  internal builds such as `0.5.29`, because auto-update compares semver and will
  treat `0.5.5` as older than `0.5.29`.
  Build full set: mac dmg+zip (arm64+x64) + win nsis x64 + Linux amd64 deb + Arch x86_64 pacman
  (`CSC_IDENTITY_AUTO_DISCOVERY=false` for unsigned Apple builds). Linux must be
  built on Ubuntu, pass `dpkg-deb --info`, and be uploaded with
  `gh release upload "$TAG" dist/*.deb --clobber` after validation.
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
  Typora parity (#154): `theme-css.js` (main) inlines local `@import`s per file
  (themes-dir only, cycles once, remote imports hoisted) and keeps url()
  `?query`/`#hash`. `customThemes.js` re-serializes the theme via CSSOM with
  ONE uniform extra ID: bare selectors become `#write …` (also keeps theme
  `p, li, button` rules off the chrome), `#write`/`.markdown-body`/`body …`
  ones get a `:not(#hm-theme)` ancestor, bare html/body/:root stay. Typora's
  base is weak, so bare `h2 {}` must beat `.milkdown .ProseMirror h2`. User
  snippets get the same +1 ID (no scoping) so snippet-vs-theme is unchanged.
  Under `hm-has-custom-theme`, app.css drops our content spacing/surfaces
  (p padding, li margin, quote/code/table fills, html-block margin, code-block
  wrapper) and floats the Crepe list label into the gutter (native outside
  marker); `hm-theme-default-bg` (theme paints no html/body/:root/#write
  background) = Typora's white page + #333. `<img>` is an allowed inline raw
  HTML tag. Locked by `test:theme-css` + `test:custom-theme-typora-base-ui`.
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
- **Mode-switch (rich↔source)** — keep-mounted + block-level offset mapping; the
  design that ended the drift on large/image-dense docs (#28/#41):
  - **Crepe stays mounted in source mode** (`EditorArea.jsx`): the source
    `<textarea>` overlays a `display:none` Crepe, so switching back does NOT
    re-parse the doc or reload its images — the rich selection/scroll is retained.
  - **Source edits sync only when real** (`useSourceModeSwitch.js` `syncSourceToRich` → Editor
    `replaceMarkdown`): a source buffer equal to baseline is a no-op, so a pure
    view-toggle never dirties the doc or rebuilds Crepe. `sourceEditedIds` is the
    "edited?" signal; `sourceModeIds` makes source/rich **per-tab** (#42).
  - **Caret anchor = markdown raw-offset ↔ ProseMirror block mapping**
    (`editor-source-map.js` `markdownOffsetToPmPos` / `pmPosToMarkdownOffset`,
    via Editor `markdownOffsetFromSelection` / `restoreMarkdownOffset`). It first
    locates the BLOCK (by visible text + occurrence index), then converts the
    in-block char offset — robust against repeated words and against image/link
    atoms that make global visible-char indices diverge between modes.
  - **Follow vs keep by caret visibility** (`useSourceModeSwitch.js` `toggleSource` + effect,
    `scrollAnchor.js` facade → `mode-caret-anchor.js`): rich caret
    visible (editing) → restore caret + follow it (scrollIntoView/focus); caret
    off-screen (reading) → keep the viewport. The textarea carries
    `__horsemdSource*` flags (selectionUser / viewportMoved / selectionAt) so a
    programmatic scroll isn't mistaken for a user scroll. `#50` keeps source
    scrollTop stable across Enter.
  - `scrollAnchor.js` is a stable facade. Implementations live in
    `mode-visible-map.js`, `mode-caret-anchor.js`, `mode-viewport-anchor.js`, and
    `mode-source-headings.js`; visible text remains a fallback path. Full
    post-mortem + design: `docs/handoff-mode-switch.md`
    (2026-07-09 entry) and `docs/editor-feature-inventory.md` §8. **CDP gotcha:** N
    tabs = N mounted editors — filter `.ProseMirror` by `offsetParent`; place
    carets with real `Input.dispatchMouseEvent` (a raw DOM selection doesn't sync
    PM state).
- **Outline folds** (#122): `settings.outlineDefaultLevel` ∈ 1/2/3/4/0
  (`OUTLINE_DEFAULT_LEVELS`, default 2, 0 = all; Settings › Editor) feeds
  `defaultCollapsedHeadings(headings, tiers)` — by hierarchy depth, not level
  numbers. Fold state is a per-tab entry in `hooks/useOutlineFolds.js`
  (structural paths + `known` + `rest` from expand/collapse-all; pure logic in
  `outline-model.js`), so folds survive tab switches and text edits; changing
  the setting clears the memory. Head button: any branch folded → expand all,
  else collapse all. Commands `outline.expandAll` / `outline.collapseAll`
  (`Mod+Alt+]` / `Mod+Alt+[`) are renderer-only capture listeners that write
  the memory, so they work with the panel hidden. Locked by
  `test:outline-default-level` + `test:outline-default-level-ui`.
- **External change reload** (`useFileOps.js` `reloadTabFromDisk`, #158):
  a clean tab whose file another program changed takes the new Markdown IN
  PLACE when its rich editor is mounted and no source textarea is (the
  source-mode `replaceMarkdown` path: programmatic, not dirty, unchanged
  blocks keep their DOM, so the viewport stays); the caret is mapped through
  the change (`lib/offset-through-change.js`) and restored without scrolling.
  Textareas / unmounted tabs remount (reloadNonce) with
  `restoreOffset`/`restoreScrollTop` + `restoreNonce`; EditorArea applies a
  restore only for the mount generation whose reloadNonce equals restoreNonce
  (open-time positions have none = 0), so other remounts never jump to a
  stale spot. `heavy` is not flipped in place. Undo can revert the reload
  (like a source-mode edit). Locked by `test:external-reload-position-ui`.
- **Rename (F2, #156)**: command `file.rename` (renderer-only capture
  listener; skipped in inputs / the rename dialog). Tree rows are focusable
  (`tabIndex -1`, `data-path`): a focused row is renamed, else the current
  document — inline via the Sidebar's `apiRef.startRename(path)` when its row
  is rendered, else the RenameModal. Tree renames/moves call `onPathMoved` →
  `retargetTabs` (exact path or folder prefix; recents too). Locked by
  `test:rename-f2-ui`.
- **Outline in source mode** (`useOutline.js` + `scrollAnchor.parseSourceHeadings`,
  #40): the outline used to blank in source mode. Now `mode-source-headings.js`
  parses CommonMark/GFM headings from the textarea (also used by caret fallback),
  the scrollspy maps `scrollTop→char→nearest heading`,
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
- **CJK-friendly emphasis** (`remark-cjk-friendly`, first in `remarkPluginsCtx`):
  `这是**「重点」**内容` parses as bold, matching Typora. Plain CommonMark
  flanking rules treat CJK punctuation like ASCII punctuation and leave the
  asterisks literal, which also made the source reprint engine pause whenever a
  user bolded text next to Chinese punctuation.
- **Media embeds** (`editor-html.js` `sanitizeMedia`, 0.13.250): `<video>` /
  `<audio>` / `<iframe>` raw HTML render as players (Typora parity). Players
  always get `controls`, never autoplay; iframes are kept only for `https:` and
  always sandboxed. The node view's `stopEvent` hands player clicks to the
  player. Relative `src`/`poster`/`<source>` resolve via the same DOM scan as
  images (`editor-dom-content.js`). Dropping a video/audio file inserts the tag
  (empty line → replaces it; inside text → own line after the top-level block);
  `useDropOpen.js` must keep media drops inside the editor. CSP needs
  `media-src … file:` and `frame-src https:`. Locked by `test:media-embed-ui`.
- **Inline SVG** (`editor-html.js` `renderSvgNodeView`, #162): an html node
  whose value is one `<svg>…</svg>` renders as an `<img>` of a
  `data:image/svg+xml` copy of the markup (scripts dropped; root
  `font-family` = the editor font when the SVG sets none) — never as live
  DOM: an image runs no script and keeps each SVG's ids and `<style>` to
  itself (two AI diagrams both using `id="g"` would repaint each other).
  Alone in its paragraph → block (no width → fills the line); next to text →
  inline icon. The export snapshot keeps that layout with preserved inline
  styles (`materializeInlineSvgForExport`); SVG images open in the lightbox
  fitted to the window on white (`hm-lightbox-vector`). `![](x.svg)` was
  already an ordinary image. Locked by `test:svg-render-ui`.
- **SVG code blocks** (`editor-svg-codeblock.js`, #166): a ```` ```svg ````
  block's preview is Crepe's `renderPreview` (like Mermaid) returning the
  #162 image (`svgCodeImage`: prolog/comments allowed, scripts dropped,
  never live DOM) at its intrinsic size (width/height, else viewBox),
  scaled down only. A 图 | 代码 switch replaces Crepe's preview toggle and
  drives it (图 = Crepe's preview-only state; 代码 = code + preview with
  the panel hidden, `hm-svg-mode-code`); typing in a focused block whose
  preview appears switches it to 代码. View-only, works read-only. Export
  always shows the picture. Highlighted as XML (an `SVG` language entry).
  Locked by `test:svg-codeblock-ui`.
- **Table paste** (`editor-table-paste.js`, #152): a GFM table is a plain
  grid with one paragraph per cell, so anything else fails the save gate
  closed. Merged cells (colspan/rowspan from Excel/WPS/web) are split by a
  `transformPasted` **plugin** in `prosePluginsCtx` — never put
  `transformPasted` in `editorViewOptionsCtx`: core spreads those options last
  and would replace Milkdown's paste-rule runner (incl. its empty-header-row
  fix). Inside a table cell, `handlePaste` (an `editorViewOptionsCtx` direct
  prop, so it runs before Milkdown's clipboard plugin, which replaces the
  selection and splits the table) fills cells from the caret, growing the
  table, or joins other blocks into the cell with hardbreaks; the Markdown
  paste path (`editor-md-paste.js`) routes through the same function. Pasted
  HTML is normalized first (`normalizePastedTableHtml`, called from
  `normalizeWebPasteHtml`): a cell holds ONE paragraph and any `<tr>` with a
  `<th>` parses as the header row, so block content in cells (paragraphs,
  lists, headings, `<pre>`, nested tables) is flattened to inline + `<br>`,
  body `<th>` become `<td>`, `<caption>` moves above. Locked by
  `test:table-paste-ui`.
- **Partial copy inside one paragraph** (`editor-copy.js`
  `copiedMarkdownContent`): `selection.content()` keeps every ancestor, so
  text inside one list item / quote / table cell serialized as `- x` / `> x` /
  a one-cell table, and md-paste (which prefers text/markdown) pasted the
  wrapper. A selection inside one paragraph copies only that paragraph's
  inline content. A whole item still copies as a list (#98: pasting it into a
  plain paragraph keeps the list), but md-paste inserts a SINGLE pasted list
  item's inline content when the caret is in another list item
  (`pasteListItemTextIntoItem`, marker-stripped source hint
  `listItemInlineMarkdown`); two or more items paste as a list. Locked by `test:list-partial-copy-ui` and
  `test:issue-151-cell-copy-ui`.
- **Code-block language** (`editor-codeblock-language.js`): Milkdown's picker
  only selects listed languages. Enter in its search box, or a click on the
  relabelled no-result row, sets the typed name as-is (first word, no
  backticks) via `setNodeAttribute`; the loader still highlights known
  names/aliases. DOM-level capture listeners only — the picker is a compiled
  Vue component. Locked by `test:codeblock-custom-language-ui`.
- **Spaced link destinations** (`lib/remark-spaced-link-destination.js`,
  Typora parity): `![](a b.jpg)` / `[x](my notes.md "t")` is literal text in
  CommonMark but an image/link in Typora (Zhihu/WeChat exports use titles as
  image names). A remark transform, FIRST in `remarkPluginsCtx` (before
  `remarkImageBlockWithPosition`), re-scans text nodes with Typora's TypeMark
  image/link regexes, only for destinations containing a space, and gives the
  new nodes exact source positions (text aligned to source; escapes/entities
  → skipped) so reprint keeps the authored bytes. Re-serialized nodes print
  `<a b.jpg>`. Locked by `test:spaced-link-destination` +
  `test:spaced-image-path-ui`.
- **CRLF code values** (`lib/remark-code-line-endings.js`): micromark keeps
  `\r\n` inside `code`/`math` values, but CodeMirror inserts `\n`, so in a
  CRLF file every code-block Enter failed the save check (editor `x\n` vs
  re-parsed `x\r\n`). The transform normalizes those values to `\n`; owners
  spell line breaks with the file's EOL on write. Locked by
  `test:crlf-code-block-enter-ui`.
- **Code-block fold** (`editor-codeblock-fold.js`): view-only toggle added
  from outside into Crepe's Vue toolbar `.tools-button-group` (first child;
  a MutationObserver re-adds it, and every DOM write is change-guarded or the
  observer loops). Blocks under 8 lines and preview-only (Mermaid) blocks hide
  it; folded = `.codemirror-host` max-height of the measured first 5 lines,
  still scrollable (`overflow-y:auto`), + a footer-style `.hm-code-fold-bar`.
  Focus entering the CodeMirror unfolds and scrolls the page by the window's
  scrollTop so the clicked line stays put. Toolbar button
  CSS must out-specify Crepe's `.tools .tools-button-group button`. Locked by
  `test:codeblock-fold-ui`.
- **Yuque exports** (`<font style=…>` everywhere, breaks inside `<font>`,
  nested lists as blank + 4 spaces = indented code): the list-slot
  fingerprint (`source-structure-fingerprint.js`) follows micromark — a line
  4+ columns past its item (or the margin) is never a slot, `2.`/bare marker
  right after top-level paragraph text or indented code is paragraph text,
  and lazy/indented continuation lines do not split a list group. Milkdown's
  default `strong`/`emphasis` stringify handlers skip attention encoding
  (`**foo.**abc` reparses as literal `**`); `remark-text-handler.js` swaps
  in the CJK-friendly ones (encode `&#x61;`) keeping `node.marker`, and the
  reprint segment printer includes a neighbour ending/starting with a
  delimiter. Locked by `test:yuque-export-edit-ui`, `test:remark-text-handler`,
  `test:source-structure-fingerprint`, `test:source-reprint-ui`.
- **Large-doc sync cost** (2026-10-23): one rich→source sync used to parse
  and serialize the whole file several times. The serializer in
  `serializerCtx` is memoized per document (and per serializer-style
  object). The sync listens to Milkdown's `updated`, not `markdownUpdated`:
  Milkdown serializes the whole document for markdownUpdated listeners on
  every 200 ms pause, even while a heavy document's sync is deferred; the
  handler serializes only when the pipeline runs now. A verified candidate's mdast seeds the
  reprint `parseSource` cache (`rememberParsedSource`; a unified processor is
  `typeof 'function'`, not 'object' — the cache never hit before). An
  unforced flush returns at once when the live doc is the exact document the
  Coordinator snapshot (or a passed committed-baseline flush check) was
  proven for (identity or `Node.eq`). `pointerdown` marks an edit without a
  block key (the selection has not moved yet). The dirty-reconcile timer
  (260 ms after a DOM mutation) does not flush while a markdownUpdated
  callback is still coming or deferred (`isMarkdownSyncPending`, capped at
  3 s because Milkdown never delivers addToHistory:false transactions): it
  used to run the full reprint between keystrokes and defeat the heavy-doc
  idle deferral (4 s of 11 s on Windows). Never write `X:has(...) <descendant>` rules over the
  editor content: Chromium restyles every match in the document on any
  child class change (was 50 000 restyles per click on a Yuque export).
  Incremental parse (`lib/source-reprint/incremental-parse.js`): the
  reprint base and the verified candidate are parsed by reparsing only the
  changed top-level blocks of a cached neighbour (3 entries per editor) and
  reusing the rest (mdast positions shifted, ProseMirror nodes reused). The
  window is cut only where micromark's state is empty (after a real
  paragraph + blank line, a heading or a thematic break) and must END in the
  same kind of closed block in its own parse (an unclosed fence/`$$`/HTML
  block falls back). Always full: any `]:` in the text (definitions are
  global and remark-inline-links deletes them), a file starting with
  `---`/`+++` (an unclosed frontmatter fence turns every later list into
  paragraph text), BOM. `areSourceDocumentsEquivalent` memoizes each
  top-level node's semantic form (WeakMap) and replays the doc-level steps
  (drop empty top-level paragraphs, image units, merge adjacent same-kind
  lists); path-bound or unknown options take the full comparison. Large
  docs (> 100 000 content size) stay deferred while typing even though the
  sync is now fast. `VITE_HM_SYNC_SELF_CHECK=1 npm run build` re-checks both
  against the full computation on every sync (toast on difference); run the
  regression/fuzz with it after touching either. Locked by
  `test:incremental-parse-ui` (seeded random edits, chained splices).
  Measurements, design and the remaining list: `docs/performance-large-doc.md`
  (2026-10-23 archive); benches in `scripts/perf/`.
  Incremental serialization (2026-10-24, `lib/incremental-serialize.js`,
  inside the memo serializer): the document is kept as segments of
  top-level children (runs of adjacent lists never split — bullets
  alternate) holding their in-context text; an edit serializes a window
  (changed segments + one unchanged neighbour each side) and splices the
  middle only when the window output starts / ends with the neighbours'
  cached text, else full. The tail segment keeps the final newline
  (Milkdown's empty-last-paragraph `<br />` rule reads the LIVE view's last
  child). Only the live document (`isPrimary`) or a document sharing half
  its nodes with the base may rebase/bootstrap — the sync also serializes
  one-block helper docs and freshly parsed docs. Heading-id-only twins reuse
  the bytes and re-key the base (`adoptEquivalent`). Wide middle segments
  are re-split at idle time. Self-check build compares every result;
  normal builds verify one in 100 at idle and disable on mismatch. Locked
  by `test:incremental-serialize-ui` (random edits, fixture + optional
  `HM_INCREMENTAL_SERIALIZE_DOC`). Bench for the user-facing operations
  (tab switch, typing, Backspace, Bold/Italic, heading level, scroll;
  `PROFILE=1`, `TIMELINE=1`): `scripts/perf/bench-heavy-ops.mjs`.
- **Cloud sync review + roadmap**: [`docs/cloud-sync-review.md`](./docs/cloud-sync-review.md)
  (2026-10-29) — current behaviour, the data-safety audit (`node
  scripts/audit-sync-safety.mjs`, `scripts/audit-sync-dirty-tab-ui.mjs`; 7
  risks incl. an unsaved-tab overwrite that loses the other device's edit),
  industry research and the P0–P3 plan. Update its log when sync changes.
- **Sync data safety (P0, 2026-10-29)**: the engine never overwrites,
  deletes or conflict-replaces a local file that is (a) open in a tab with
  unsaved edits — the renderer passes `dirtyPaths` with every `sync:run`
  (`useSyncWorkspaces` `getDirtyPaths`) → `busyPaths` — or (b) changed
  since the scan (`localStillAsPlanned` re-hashes right before the write;
  a throttled run can sit between plan and write for 20 min). Those paths
  are `deferred`: state / manifest left exactly as before, so the next run
  sees a conflict. (P0 held deletions / conflicts in automatic runs; since
  P2 they run — see Automatic sync below.) Conflict copies are
  `name (冲突副本 <host> <YYYY-MM-DD HHmm>).md` (`sync/conflict-name.js`,
  host name via `deviceLabel`), never an existing name, never overwritten.
  Uploads record the hash of the bytes actually sent. A lost manifest race
  is tagged `manifestChanged` and `SyncService.run` re-plans (3 tries).
  Save over an external change (`useFileOps` `saveOverExternalChange`):
  three-way merge (`lib/three-way-merge.js`, node-diff3; base = the tab's
  `savedContent`), merged text shown in place (`adoptDiskContent`, shared
  with the external reload); overlapping edits keep the disk version and
  save the editor text as a conflict copy the tab moves to. Saves are atomic
  (`writeFileAtomic`: copy with metadata — `/bin/cp -p` on macOS keeps
  Finder tags — write, fsync, rename; hard links / failures write in place;
  Windows replaces a file held open by moving it aside first). Temp files
  (`*.hmtmp`, the sync's `.<pid>.<uuid>.tmp`) never sync. Locked by
  `test:sync-safety`, `test:atomic-save`, `test:save-external-merge-ui`,
  `test:sync-auto`, `test:autosave-ui`; `npm run audit:sync-safety` reports
  the remaining risks.
- **Local version history + 最近删除 (P1, 2026-10-29)**: `main/history/`
  (`history-store.js` pure: `userData/history/objects/<sha>.gz` stored once
  per content, `index/<hash>.json` per file, `deleted.json`;
  `history-service.js`: hooks + IPC `history:*`). It always keeps the version
  ABOUT TO BE REPLACED: `fs:writeFile` → `recordBeforeSave` (≤ 5 MB, one per
  5 min per file (Obsidian), forced when a save removes > 30 % of the text), `fs:delete`
  → `recordBeforeTrash`, the sync engine → `keepLocalVersion`
  (`sync-overwrite` / `sync-delete`, ≤ 100 MB; local deletions no longer go
  to `<folder>/.horsemd/trash` — that is only the fallback when the history
  cannot keep the bytes), `history:restore` keeps the current file first.
  `fs:rename` moves a file's / folder's history. Retention: all < 1 h,
  hourly < 1 day, daily < 30 days, weekly up to `historyRetentionDays`
  (30/90/365, Settings › 通用 › 保存与恢复, `SaveRecoverySettings.jsx`); pinned never pruned; 1 GB cap, oldest
  first; unreferenced content collected after a minute (re-used content is
  touched). The root is resolved lazily (after --user-data-dir). Renderer:
  `HistoryDialog` / `DeletedFilesDialog` (opened via `lib/history-ui.js`
  events; file-tree / tab context menu, commands `file.history` /
  `file.deleted`, hidden when `window.api.historyList` is missing — mobile).
  Locked by `test:history-store`, `test:history-ui`; the audit is 0 risks.
- **Sync throttling** (`main/sync/request-pacer.js`): S3/WebDAV requests go
  through a per-provider pacer — 429/503 retried (Retry-After or jittered
  backoff, 8 attempts, re-signed each time), the request gap doubles per
  throttle and decays on success. A sync stopped half way left uploaded
  objects without a manifest; the engine now adopts an existing object with
  identical bytes on a create-only conflict. 数据胶囊 (measured 2026-10-23)
  limits only PUTs: ~200, then every PUT is 429 for ~20 min with no
  Retry-After. After the short retries the pacer probes every 2 min (up to
  45 min) and reports `{locked, resumeAt}` via `onThrottle` → `sync:progress`
  → Settings › Sync; after a lock, PUTs stay ≥ 10 s apart. Write and read
  gaps are tracked separately (reads are never slowed by upload throttling).
  Pause / continue / stop (`sync/sync-control.js`, IPC `sync:control`): the
  engine checks the control between files; the pacer sleeps through it, so a
  stop ends a throttling wait at once. A stop commits the completed part
  (manifest first, quick retries only, then local state — the two must agree,
  else the next sync would take new local files for remote changes); if the
  manifest cannot be written, nothing is recorded and the next run resumes by
  adopting identical objects (also for modified files, If-Match 412).
  Locked by `test:sync-throttle`, `test:sync-control`, `test:sync-throttle-ui`.
  Empty folders (`scanLocalEmptyDirs`, `buildDirPlan`, manifest/state
  `dirs`): only leaf folders with nothing in them are tracked; S3 writes a
  zero-byte "path/" marker (`createDirectory`), WebDAV a collection. A folder
  that holds (or receives) files is just forgotten (`forgetDir`) — never
  deleted. `removeDirectory` deletes only after a listing / PROPFIND shows it
  empty: 数据胶囊 deletes "folder/" RECURSIVELY (all objects under it, even
  without a marker), and WebDAV DELETE on a collection is recursive too.
  Locked by `test:sync-empty`.
  Requests (#161): every provider request goes through
  `sync/sync-request.js` (in SyncService): a deadline over the WHOLE
  exchange (60 s + bytes at 32 KB/s; the body is read there) — before, a
  request the service never answered kept the folder locked ("这个文件夹正在
  同步") until restart. With --horsemd-input-trace each request is logged
  (method, credential-free URL, status, bytes, ms; never headers). Renderer
  `useSyncWorkspaces.run` refuses a second start and only the starting call
  clears busy; the plan's confirm is disabled while busy; `sync:status`
  restores the busy state in a reloaded / reopened window (progress falls
  back to `sendToRenderer`). Locked by `test:sync-request`,
  `test:sync-issue-161-ui`.
  Trash copy + system files (#161 follow-up, `sync/sync-ignore.js`): a
  cloud file is backed up to `.horsemd/trash/<stamp>/` before it is deleted
  or replaced — by S3 server-side copy (`S3Provider.copy`, CopyObject;
  nothing downloaded) when the copy's ETag equals the planned revision,
  else download + sha256 compare + upload as before (WebDAV always).
  数据胶囊 (measured 2026-10-25) ignores `x-amz-copy-source-if-match` and
  answers a missing source with 200 + empty ETag, so only the ETag
  comparison counts. `.DS_Store` / `._*` / `Thumbs.db` / `desktop.ini` never
  sync (by file name; other dot files do); one in the cloud is deleted
  there without a trash copy, hidden from the preview list and not counted
  as a deletion; a folder holding only those is an empty folder (and is
  removed with them). Locked by `test:sync-trash-copy`.
  Renamed / deleted folders (2026-10-27): a file deleted on another device
  takes the local folders it leaves empty with it (`removeEmptiedParents`,
  rmdir only, system files ignored) — before, the old folder stayed empty,
  the next sync uploaded it as a new empty folder and it came back on every
  device. Right after the deletions (before any upload), cloud folders
  emptied by this run's deletions are removed too — later, a case-insensitive
  WebDAV server put Notes/a.md into the still-present notes/
  (`removeEmptiedRemoteParents`, deepest first,
  via `removeDirectory`'s emptiness check, best effort): WebDAV collections
  and 数据胶囊's automatic "folder/" objects stayed behind. Tracked empty
  folders are skipped (the folder step recreates / keeps them). Locked by
  `test:sync-empty` §8.
  Moves / renames (2026-10-27): there is no rename operation — a move is a
  delete of the old path + an upload of the new one. Deletions run FIRST
  (`prepare` sorts them ahead): on a case-insensitive disk a case-only
  rename (notes/ → Notes/) is a download and a delete of the SAME file;
  download-first moved the only copy to the trash and the next sync spread
  the deletion everywhere. Locked by `test:sync-move` (13 scenarios: moves,
  case-only renames, concurrent edit / new file / different moves on the
  other device, swaps; `HM_SYNC_MOVE_WEBDAV` + `_ROOT` run them against a
  real server, e.g. WsgiDAV, and check its disk); end-to-end checked with two
  HorseMD instances on 数据胶囊 and Windows ⇄ macOS on 七牛.
  WebDAV workspace prefix (2026-10-27): `HorseMD/<id>` was never created, and
  a standard server (Apache, WsgiDAV, Nextcloud) answers 409 to PUT / MKCOL
  under a missing collection — every new WebDAV workspace failed its first
  sync with「上传失败（HTTP 409）」. `ensurePrefix` creates it once per
  provider. The mock servers accepted anything; `test:webdav-apache` now
  covers a prefixed new workspace on real Apache.
  七牛 (#161, measured 2026-10-26 with a real bucket): every download
  carries `content-disposition: …filename="<key>"` with the key's Chinese
  as raw UTF-8. Electron's `net.fetch` throws on that header inside its own
  listener (uncaught, swallowed by the process guard) and never settles, so
  every Chinese-named download hit the 60 s timeout. Sync requests use
  `sync/electron-request.js` (`net.request`, raw headers → non-Latin-1
  values passed on as UTF-8 bytes, `cache: 'no-store'` — net.fetch served
  manifest GETs from the HTTP cache); do not switch back to net.fetch.
  七牛 also writes ETags as `&#34;…&#34;` in XML, so both XML parsers use
  `htmlEntities: true` (numeric references; `&amp;` still decoded once).
  Locked by `test:sync-electron-request` (bare Electron + raw server).
  Automatic sync — 无感同步 (P2, 2026-10-29; `hooks/useAutoSync.js`):
  `settings.syncAuto` default ON (SiYuan), `syncAutoMinutes` ∈ 5/15/30/60
  (default 5) is only the fallback check. Triggers per bound folder: a save
  inside it (`hm:file-saved` from `useFileOps`) → 30 s after the last save,
  at most 2 min after the first unsynced one (数据胶囊 PUT budget); start
  (+10 s); focus / visibility when the last run is > 60 s old; the fallback
  interval. One pass at a time. `sync:run` `{ automatic: true }` (`safeOnly`
  is the old name): deletions and conflicts RUN (recoverable from P1
  history); brakes return `{ needsConfirmation, reason }` and touch nothing:
  `remote-reset`, `mass-delete` (`massDeletion`: > 50 % of tracked files
  and ≥ 10, or ≥ 100; deletions whose content reappears = moves, not
  counted). A folder that waits shows `SyncAttention` under it in Settings ›
  云同步 (what happened — `counts` from the remote-reset preview: files here /
  in the cloud — and the choices: re-upload, use the cloud's files only when
  it still lists some, review the deletions, stop syncing; each opens the
  confirmable plan); the first one scrolls into view, so the status bar's
  需要确认 lands on it. A one-line status with the choices behind the
  双向同步 icon told users nothing (mini 2026-10-29: a cleared 数据胶囊
  workspace). Manual 双向同步 runs without a preview unless it is a mass
  deletion (the brake is automatic-only, so a confirmed run goes through).
  Both-sides edits of a text file (`sync-base.js`: last-synced content per
  file in `userData/sync/base/<ws>`, backfilled after a commit) merge with
  `shared/three-way-merge.js`; otherwise a conflict copy. Results carry
  `merged` / `conflicts` (copies made) / `deferred`. Toasts: first error of
  a streak only (SiYuan), one per brake situation, merged / conflict counts.
  Auto-save is 3 s when auto sync is on and a folder is bound
  (`autoSaveDelay || 3`). Status bar `SyncStatusItem` (同步中 / 需要确认 /
  同步出错 / 已关闭 / 已同步 HH:MM; click → Settings › 云同步). The scan
  reuses hashes of files whose size + mtime did not change
  (`local-files.js` cache). Locked by `test:sync-auto` +
  `test:auto-sync-ui` (`__hmAutoSyncTick`, `__hmAutoSyncSaved(path)`).
- **Editable inline HTML spans** (`editor-html-span.js`, 2026-10-23, Typora
  parity): a balanced `<font …>`…`</font>` / `<span …>`…`</span>` pair inside
  one phrasing parent (paragraph/heading/cell/strong/…; never at block level)
  becomes an `hmHtmlSpan` mdast node → the `html_span` mark (attrs: exact
  open/close tag bytes), so Yuque text takes a caret and partial selections
  instead of being one locked atom. Pairs with no visible text (anchors,
  Yuque's `<font>  \n</font>`), nested same-kind pairs and unbalanced tags
  stay raw html. Stringify prints open + phrasing + close; a break inside
  stays `  \n` (the close tag then starts the next line, as Yuque writes it).
  Milkdown's `#moveSpaces` moves edge blanks out of EVERY mark run, so: the
  validator and reprint compare blanks without strong/emphasis/link/html_span
  (run-wide, not just edges) and ignore line-start blanks after a hard
  break; reprint prints those line-start blanks via a U+E000 stand-in
  (`&#x20;` at a line start, a space after the open tag); reprint keeps
  html_span on a break only when it is the break's only mark; edge blanks
  split from a span run drop the span. Adjacent identical spans merge in PM
  (an edited block may print `<font a>x</font><font a>y</font>` as one).
  `diffSequences` resynchronises in a window when the LCS table would be too
  large (it used to reprint every block between two distant changes).
  Locked by `test:html-span-edit-ui`, `test:yuque-export-edit-ui`.
- **Typed HTML tags** (`editor-html-input.js`, Typora parity): typing the `>`
  of a tag (or `-->`) in rich mode replaces the raw text — back to the
  matching `<name …>` for a closing tag — with the editor's own parse of it
  (html atom / editable `<font>`/`<span>`), keeping the surrounding marks.
  Before, typed tags stayed text and saved as `\<tag>`. Skipped: inline code,
  code blocks, mixed marks/atoms, a block tag (`<div>`, `<p>`…) at the start
  of a text block (Markdown makes the whole paragraph an HTML block). Locked
  by `test:html-tag-input-ui`.
- **Subscript / superscript** (`editor-subsup.js`, Typora parity): `H~2~O`
  / `x^2^`, each behind a setting (`markdownSubscript` / `markdownSuperscript`,
  default OFF like Typora — Chinese `1~2天，100~200元` would subscript the
  middle), read live (`markdownSyntaxRef`): toggling re-parses the open
  documents (flush unforced → reset parse caches → replaceMarkdown, not
  dirty). With subscript OFF a lone `~` is not escaped on save
  (`setLoneTildeEscaping`); only `~~` is.
  A remark transform splits ONE text node, aligned to the source (escaped
  `\~` never delimits; unalignable nodes are left alone), content without
  unescaped whitespace (`\ ` = space), positioned so reprint keeps bytes
  (inline-map treats the nodes like `delete`). Marks always exist; parseDOM
  (own `.hm-sub/.hm-sup` copies) and input rules only when on; `^`/`~` added
  to stringify `unsafe` when on. Locked by `test:subsup-ui`.
- **Input-rule anchoring** (`lib/input-rule-guards.js`): Milkdown's underscore
  emphasis rule `/\b_(?![_\s])(.*?[^_\s])_\b/` had no `$`, so `_x_` anywhere
  before the caret (inline code `_<font>…</font>_`) fired on every keystroke,
  deleting a character and swallowing the typed one (pre-existing). Patched in
  place in `inputRulesCtx` after create: anchored regexp, and every
  non-backtick rule skips ranges that contain inline code.
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
- **Slash (`/`) menu** (`editor-slash-menu.js`) is **self-built**, NOT Crepe's
  built-in BlockEdit slash. Crepe's filters items by `label.includes(filter)`
  ONLY (no keyword field), so typing past `/` (e.g. `h1`, `#`, `ol`) against the
  Chinese labels matched nothing and the menu appeared to "vanish". We keep
  `Feature.BlockEdit` ENABLED (the block drag/add handle `.milkdown-block-handle`
  is a separate slice we must preserve) but **neutralize its slash** by overriding
  the slice named `"CREPE_MENU_SLASH_SPEC"` (a `$ctx` slot whose `$prose` reads a
  PluginSpec from it) with a no-op view — `disableCrepeSlash(ctx)` in
  `editor-slash-menu.js`, called from `editor-crepe-setup.js`. Reach it by **string
  name** (`ctx.update('CREPE_MENU_SLASH_SPEC', …)`): Milkdown slice ids are
  per-call **Symbols**, so re-running `slashFactory('CREPE_MENU')` here would mint
  a different id and MISS Crepe's registered slice (→ config callback throws →
  `crepe.create()` silently rejects → editor never mounts). Our menu is a raw
  ProseMirror plugin in `prosePluginsCtx` (the channel for raw plugins; do NOT use
  `crepe.editor.use` for it) owning a `SlashProvider` for positioning; filter =
  label OR i18n keywords (`slash.kw.*`, zh+en+abbrev+symbol) ranked exact > prefix
  > substring (so `/-` → bullet's exact `-`, not divider's `---` substring); with
  a query it renders a flat ranked list, without one the grouped full menu. Insert
  semantics are byte-identical to Crepe's block-edit (`clearTextInCurrentBlockCommand`
  then `setBlockType`/`wrapInBlockType`/`addBlockType` with `view.state.schema.nodes`
  node types). **`/<language>`** (e.g. `/java` `/python` `/mermaid` `/js` `/c++`):
  when the query matches a known language alias (`LANGUAGES` table → canonical
  name), the generic "code" item is replaced by a "code · <lang>" item that
  inserts a `code_block` with `attrs.language` preset (Typora/Feishu behavior);
  `/mermaid` thus yields a diagram block (rendered via the code-block preview).
  The menu DOM mirrors Crepe's structure (`.milkdown-slash-menu` >
  `.menu-groups` > `.menu-group` > `h6` + `li[svg,span]`, `.hover`/`.active`) so it
  inherits Crepe's `block-edit.css` theme + the bounds-fixer in
  `editor-dom-bindings.js` (which keys off those classes).
- **Math**: enable `CrepeFeature.Latex` (off by default). Block math needs `$$` on
  their own lines. Crepe's `remarkMathBlock` rebuilds every `math` node as a
  `code` node (lang LaTeX) WITHOUT `position`, so the source reprint engine
  sliced at `undefined` (the whole document printed twice around the edit)
  and every edit inside a `$$` block — a new 公式 from the slash menu or one
  read from the file — ended in「富文本与源码不一致」(Windows trace
  2026-10-27; 0.13.257 too). `lib/remark-math-block-position.js` does the
  same conversion first, keeping the position (registered before Crepe's
  plugins, like `remarkImageBlockWithPosition`); `patchCodeBlock` treats `$$`
  as a fence for LaTeX nodes (only the content lines change); `reprintSource`
  refuses any edit without integer offsets (`reprint-unpositioned`). Locked
  by `test:math-block-edit-ui`. Long display math scrolls (`.katex-display { overflow-x:auto }`).
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
- **List conversion source fidelity**: right-click conversion owns only the
  current list level's marker/checkbox. Use the actual hit text position, build
  the converted canonical snapshot from the transaction document before
  dispatch, and patch only changed marker prefixes. `markdownUpdated` can arrive
  during dispatch, after the next keystroke, or at source flush; waiting for it
  and replacing the complete serializer list rewrites nested compact spacing and
  indentation. `npm run test:list-conversion-ui` must cover immediate human-like
  typing, source bytes, save, process exit and full reopen.
- **Forced rich flushes** must serialize `view.state.doc` with `serializerCtx`.
  `crepe.getMarkdown()` is a listener-backed snapshot and may lag behind a
  keyboard transaction that is already visible in ProseMirror; using it for an
  immediate save or source switch can lose the last input after reopen.
  `saveTab()` must call `getMarkdownForTab()` and update `tabsRef` before writing;
  `commitAllLive()` alone covers only uncontrolled source textareas.
- **Sync diagnostics** (`lib/sync-diagnostics.js`, `editor-sync-event-log.js`,
  `SyncReportDialog.jsx`): users hit「检测到富文本与源码不一致」/ the save-time
  recovery prompt without --horsemd-input-trace, so nothing reached us. Every
  editor keeps the last 40 input events in memory (passive capture
  listeners: keys, beforeinput, IME, paste/cut/drop, clicks, each with the
  caret's block path). A failure keeps the stale source + the live doc
  (references only); the toast asks the user to send the details (`action.hint`) and its
  prominent「查看详情」button (toast `action`) builds the
  report lazily: version, OS, reason, the differing top-level blocks (heading
  ids ignored) as raw source (CRLF ␍ / tab → visible) and as the editor
  serializes them, the events. The dialog's text is editable; 复制 /「在 GitHub
  提交」(bug form prefilled via URL params; > 7000 chars → copied + paste
  prompt) use the box. 「复制，微信发给作者」copies it and shows the author's
  WeChat ID (`AUTHOR_WECHAT`, public in guide/community.md; copyable). Save (`useFileOps`) and source-switch recovery toasts
  carry the same button (`getSyncReport`). The trace harness has
  `forceSyncFailure(reason, staleSource)`. Locked by `test:sync-diagnostics` +
  `test:sync-report-ui`.
- **Rich/source pause families (0.13.235)** — found by
  `scripts/fuzz-rich-source-ui.mjs` (seeded real-Electron random editing; oracle =
  live PM doc vs Save → cold reopen, plus mismatch toasts). Fixes, each locked by
  `test:rich-source-pause-families-ui` + a pure test:
  - Blockquote owner: quote paragraphs with marks or several `> `/lazy lines no
    longer fail closed on every keystroke. `planInlineLocalizedPatch` diffs the
    paragraph, aligns PM text to the paragraph's own prefix-stripped raw lines
    (the shared `pmPosToMarkdownOffset` ignores continuation `> ` prefixes and
    can collapse to the block start), verifies deleted raw bytes == deleted
    text, tries literal / escaped / mark-delimiter-wrapped spellings (`*e*`
    input rule), and validates on a BOM-less LF copy. Pure mark toggles stay
    fail-closed; legacy stays blocked for the family.
  - Validator (`semanticJson`): table-cell **edge** whitespace is ignored (GFM
    trims it); interior text stays strict.
  - Table cell owner: when position mapping fails it falls back to
    `mapTableCellBySlot` — table found by content (header row + delimiter row +
    every body row cell-for-cell), only the target slot's trimmed bytes change,
    `|` always escaped, in-cell line breaks spelled `<br>` (hardbreak is now part
    of the plain-cell contract). Use text-node concatenation, not
    `textContent`: Milkdown's hardbreak has `leafText` "\n".
  - Milkdown's trailing-paragraph append (doc ending in table/list/code/quote)
    is adopted as an editor-only document change
    (`isTrailingEmptyParagraphAppend` + `sourceSyncBridge.adoptEditorOnlyDocument`)
    after validating source ≈ new doc, instead of becoming step 1 of the next
    journal (which made every focused owner see two top-level changes).
  - `preserveParagraphSplit`: Enter next to inline markup splits after the
    closing delimiters and before the opening ones, using the canonical output
    around the inserted separator as the oracle.
  - **Journal locality + editor-only changes** (`lib/source-sync/editor-only-document.js`):
    focused owners prove ONE top-level block, so `handleSourceTransactions`
    publishes the pending journal (forced flush; dispatch runs before
    `view.updateState`, so it sees exactly oldState) when a transaction touches
    top-level blocks disjoint from the journal's changed range — `markUserEdit`'s
    DOM-driven flush misses CodeMirror/IME/undo edits. Milkdown's
    `syncHeadingIdPlugin` dispatches separate id-only `setNodeMarkup`
    transactions after heading edits; `isHeadingIdOnlyChange` closes the
    pending journal and adopts them as editor-only (ids have no Markdown).
  - `remarkFixMarkerOffsetForBom`: Milkdown's `remarkMarker` reads
    `file.value.charAt(offset)` where offsets exclude a BOM but `file.value`
    includes it → every `*`/`_` marker in a BOM file was the char to its left
    and canonical printed delimiters as spaces. The fix is order-independent.
- **Source reprint engine is the primary rich→source path** (R3,
  [`docs/source-reprint-architecture.md`](./docs/source-reprint-architecture.md)):
  `reprint(source, editorDoc)` diffs `parse(source)` against the editor
  document, keeps authored bytes of unchanged subtrees and the frames of changed
  containers, patches text blocks at character/segment level, and is verified
  **directly against the editor document** (never via canonical). Run order:
  precise reprint → existing focused owners/legacy → degraded reprint (inside
  `reportSourceSyncFailure`) → pause. Editor-only/no-encoding states are listed
  once in the design doc §5 — extend that table, do not add per-gesture owners.
  `globalThis.__hmSourceReprintPrimary = false` switches it off (owner tests do
  this to pin the fallback path). Tests: `test:source-reprint-ui` (real Crepe,
  `__hmSourceReprintHarness` under `--horsemd-input-trace`); fuzz reports carry
  shadow stats; `scripts/lib/shadow-triage.mjs` summarizes them.
- **Full-screen mode** (`hooks/useImmersiveMode.js`, command `view.immersive`,
  default `Mod+Shift+Enter`, top-bar button, View menu): the `.app.hm-immersive`
  class hides the whole shell (tabs, activity bar, sidebar, status bar, save FAB,
  floating outline, block handles); the window is NOT resized (user choice). Esc
  exits unless a popup owns it — decided in the CAPTURE phase, because
  ProseMirror's base keymap prevents every Escape (selectParentNode) and the
  slash menu has already closed by the bubble phase. Mobile also hides the system
  status bar (`window.api.setSystemBarsHidden`). Desktop edge reveal
  (`.hm-immersive-edges` + `hm-reveal`): the pointer within 16 px of the
  top (the empty space above the first line) or 10 px of the bottom / left
  edge (no button pressed) slides the WHOLE shell in — top bar, status bar,
  activity bar + open sidebar, in the normal window arrangement — as fixed
  overlays, after the pointer rests 100 ms in the zone (crossing it on the
  way to the Dock / menu bar and leaving the window reveals nothing), and
  out 450 ms after the pointer leaves all of them. In 0.26 s
  (decelerating), out 0.2 s, with a fade; static shadow, `will-change`
  bars. The document slides right just enough to clear the sidebar: an
  INLINE `transform` (or, in a window too narrow for that, `margin-left`)
  on `.pane-center`, measured on the plain layout BEFORE the reveal and
  committed in the same task (`flushSync`), so bars and text start in the
  same frame; re-measured when the sidebar opens/closes and after every
  click while out (measure against the transform's CURRENT animated
  value). Never a CSS variable on `.app` / `.pane-center` (inherited: every
  change restyled the ~6 000 elements of a long document, 10+ ms in the
  slide's first frame), and never a `.app.hm-… X *` rule (a universal
  descendant makes every `hm-reveal` toggle restyle the whole app). The
  hide timer checks where the pointer last was (`pointerStays`), not
  focus: a click on a bar moves focus without moving the pointer (held
  while a `.menu-backdrop` is open or a text field inside has focus).
  Hidden bars sit outside the window with `-webkit-app-region: no-drag`
  (named drag elements only), so the top of the document never drags the
  window. First-use hint (`hint`, `.hm-immersive-hint`): entering shows a
  pill ("any of the top / bottom / left edges") + a glow on the three edges
  for 4.5 s, `pointer-events: none`; never again once the bars were
  revealed, at most 3 times (`localStorage horsemd.immersiveHint.v1`).
  Locked by `npm run test:immersive-mode-ui`.
- **Reading mode** (#163, `hooks/useReadingMode.js`, `settings.readingMode`,
  command `view.readingMode`, default `Mod+Shift+R`, status-bar switch,
  persisted): desktop documents become read-only through the same `readOnly`
  prop the mobile lock (`settings.mobileReadOnly`, mobile only) and the
  source/rich preview use — `editable` false, contentEditable false, the
  capture-phase key/beforeinput/paste/drop blocks in `editor-dom-interactions.js`,
  readOnly source textareas. App-level writers are blocked too:
  `READ_ONLY_BLOCKED_HANDLERS` in `menuHandlers.js` (replace, attach,
  review commands → hint toast), no replace row in the find bar, no outline
  drag, review cards keep only their copy actions. A plain click opens a link
  (Ctrl/Cmd still needed while editing). A click on inline code does not enter
  its editing state (no backtick delimiters; `editor-inline-code.js` skips
  `view.editable === false`, and a read-only view hides any left over). External-change reloads still apply.
  Entering with the caret in the editor is safe: Chromium moves focus off the
  now non-editable view, so ProseMirror keymaps (Mod-B…) never run. Locked
  by `test:reading-mode-ui`.
- **Heading folds** (`editor-heading-fold.js`, a raw plugin in
  `prosePluginsCtx`): a folded top-level heading hides every top-level block
  after it up to the next heading of the same or a higher level. View-only:
  plugin state (`{pos, end}` per fold: the heading maps with assoc 1, the
  section end remembered at fold time with assoc -1, capped at the next
  same-or-higher heading) + node decorations (`hm-fold-hidden` →
  `display:none`); nothing reaches the Markdown, never dirty, not saved.
  Enter at the end of a folded heading inserts a paragraph AT the end (the
  next visible line, Obsidian/Feishu) and keeps the fold — it used to split
  the heading into the section and open it; Backspace in that empty line
  deletes it and returns to the heading end (`handleDOMEvents.keydown`, so it
  runs before Milkdown's keymaps; `handleKeyDown` for Android's synthetic
  Enter). The blank-area click (`editor-dom-layout.js`) measures the last
  VISIBLE block: a folded last section is display:none, so every click
  counted as "below the content" (empty paragraph appended, caret thrown to
  the end). A folded heading carries its section: copy / cut of a selection
  covering the whole heading text take the section (`foldedSelectionRange`
  → `editor-dom-content.js` builds that clipboard from the document —
  hidden CodeMirror blocks render no lines — and plain text via layout);
  a block-handle drag of it (`dragstart` on document after Milkdown's,
  `view.dragging` swapped for the section slice, plugin `handleDrop`) moves
  / Alt-copies the whole section and folds it again where it lands
  (`foldRange`). A deleted heading's fold is dropped (`mapResult.deleted`;
  it used to land on the next heading). Locked by
  `test:heading-fold-section-ui`. Raw Markdown paste into an empty
  top-level paragraph (`prepareRawMarkdownPaste`) pads the pasted bytes with
  a blank line each side — the empty line has no source bytes, so a paste
  after Enter wrote `尾段\n## 标题`. The selection never stays in hidden
  content: a non-fold transaction whose selection lands there opens the folds
  around it; a fold action that would hide the caret moves it to the folded
  heading's end (appendTransaction). Toggles are an overlay after the editor
  DOM (outside the contenteditable), right after the heading text — the
  leading gutter is the block handle's. Hover shows one, folded headings keep
  one, Alt-click = every heading of that level. App code talks to it through
  a `hm-heading-fold` CustomEvent on the editor DOM (`toggle`/`foldAll`/
  `unfoldAll`; `reveal` dispatched on a hidden element by `find.js`
  `scrollRangeIntoView` and the outline's `jumpAndStabilize`). The outline
  scrollspy skips box-less (hidden) headings. Export suspends the folds while
  the snapshot measures the live DOM. Commands `editor.fold.toggle`
  (`Mod+Alt+Period`) / `editor.fold.all` / `editor.fold.none` are
  renderer-only capture listeners (reading mode moves focus off the editor);
  the context menu offers fold / fold every H<n> / unfold all, also when
  read-only. Locked by `test:heading-fold-ui`.
- **Closed tabs release their editor** (2026-10-26, Windows "twice
  Typora's memory"): every closed tab used to stay in memory (15 rounds of
  opening/closing 5 files: 184 → 465 MB, 228 Crepe instances). Anything
  app-wide or module-level must not hold an editor strongly — an editor's
  `getT`, remark processor, view or ctx closes over its whole setup scope.
  Register per-editor entries with a `cleanups.push` removal
  (`__hmIncrementalSerializeAll`, the trace harness), hold processors in
  caches through `WeakRef` (`editor-source-map.js` block cache), reach a
  translator from shared code via `lib/live-translator.js`, and stop idle
  work on destroy (`incrementalSerializer.dispose()`): an idle serialize
  after destroy throws `editorView not found` in Milkdown's paragraph rule,
  and the console keeps the uncaught error — and through its stack, the
  editor. Milkdown's own `$command` objects remember the most recently
  created editor (one at most; library). Diagnose with a heap snapshot and
  shortest retainer paths (ignore WeakMap key→value edges). Locked by
  `test:closed-tab-memory-ui`.
- **Auto-save** (`hooks/useAutoSave.js`, `settings.autoSaveDelay` ∈ 0/3/10/60 s,
  default **0 = off**, Settings › 通用 › 保存与恢复 (Typora: General › Save & Recover), #136): after N s of inactivity (and on
  window blur) a dirty tab **with a path** is written via `saveTab(id, false,
  { auto: true })` — the same live-markdown + source-sync integrity gate as
  Cmd/Ctrl+S, but silent. Auto mode never: opens a dialog, writes a recovery
  copy, relocates pasted images (`data:`/`paste-images` links wait for an
  explicit save — that rewrite remounts the editor), or overwrites a file
  changed/removed on disk (`fs:writeFile` `expectedMtimeMs` guard → `{conflict}`;
  the tab is paused until its mtime changes). `writeTab` marks
  `savedContent: written` (the bytes written, never the newer `t.content`), and
  `saveTab` clears `pendingRichEdit` when it resolves the live markdown, not
  after the write — so typing during an in-flight save keeps the tab dirty.
  While auto-save will write a tab (`useAutoSave` → `isAutoSaved`: a path,
  auto-save on, not paused by a conflict / pending images / an error / a
  source-sync pause) the floating Save button is hidden (VS Code / Office);
  untitled and paused tabs keep it. An explicit save under auto-save
  (`keepVersion`) also keeps the written content as a `manual` (手动保存)
  history version (Sketch: ⌘S = a version), and the first two times the
  toast says saving by hand is not needed (`horsemd.autosaveHint.v1`).
  Locked by `npm run test:autosave-ui`.
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
- **User command PATH** (`main/shell-path.js`, #160): a macOS app started
  from Finder / the Dock has PATH=/usr/bin:/bin:/usr/sbin:/sbin, so npm /
  Homebrew / nvm tools (`picgo`, itself `#!/usr/bin/env node`) were "command
  not found". The image-host command runs with `userCommandEnv()`: the login
  shell's PATH (`$SHELL -ilc`, markers, 5 s timeout, resolved once at startup)
  + process PATH + common tool dirs. Windows unchanged. Locked by
  `test:shell-path`, `test:image-host-path-ui`.
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
  ranges without mutating the DOM. See `hooks/useFindReplace.js` and `find.js`.
- **Global search** (issue #120): the sidebar's third mode (`sidebarMode
  'search'`, ActivityBar button, `Mod+Shift+F`). Space-separated keywords are
  AND-matched per file in the main process (`search:workspace` reuses the
  sidebar's `listMarkdownFiles` scope + `isRestrictedWatchRoot` guard, with an
  mtime-validated content cache). Clicking a result opens the file and lands
  the in-document FindBar on that occurrence: source/plain tabs jump by
  `occIdx` (globalsearch-core counts occurrences with the EXACT find.js
  `matchIndices` semantics — case-insensitive, non-overlapping — so the index
  is exact), rich tabs call `restoreMarkdownOffset(fileOffset)` then pick the
  nearest highlighted range at/before the caret. Untitled tabs carry
  `path: null` — path comparisons must tolerate it.
- **File watcher must stay crash-proof.** chokidar recursively watching a tree
  with permission-protected paths throws a flood of `EACCES`/`EAGAIN`/`EBUSY`
  that, left unhandled, `abort()`s the whole main process on launch. The trap:
  a **relative** workspace path like `"."` resolves against the process CWD, which
  is `/` under Finder/launchd → it watches `/dev`, `/System/Volumes`, … (works in
  `npm run dev` only because the shell's CWD is the repo). So `watch:start` only
  watches **absolute** paths and refuses restricted roots (`isRestrictedRoot`:
  `/`, `.`, `..`, relative, `/dev`, `/System/Volumes`, …), ignores system trees,
  sets `followSymlinks:false`, and every watcher has an `'error'` handler; the
  renderer drops non-absolute/restricted folder roots (`sanitizeFolderRoots` +
  `isRestrictedPath` in `paths.js`, mirroring main's `isRestrictedRoot`); and a
  process-level `unhandledRejection`/`uncaughtException` guard in `main/index.js`
  is the final safety net. Don't remove these. On Windows the folder watcher
  (`workspace-watcher-worker.js`) is ONE recursive `fs.watch` on the root,
  not chokidar (2026-10-27): chokidar opens a handle per folder and Windows
  refuses to rename a folder while anything inside is open, so with a
  workspace open no folder holding subfolders could be renamed, in HorseMD's
  tree or in Explorer (EPERM). Same events / filters; macOS and Linux keep
  chokidar. `test:workspace-watcher` runs both modes. Also: main-process network calls
  use Electron's `net.fetch` (Chromium stack), not Node's global `fetch` (its
  c-ares resolver can abort an unsigned app under launchd).
- **Don't commit `dist/` or `out/`** (gitignored). `build/icon.*` IS tracked.
- **Chinese / English document fonts**: `settings.fontWrite` is the Chinese
  font, `settings.fontWriteLatin` the English one; `writeFontStack(latin,
  cjk)` builds English → Chinese → default (unset English = the default
  Latin fonts, so letters never take the Chinese font's Latin glyphs unless
  chosen). Per-glyph fallback does the split (English fonts have no CJK).
  Settings saved before the split (no `fontWriteLatin` key) load with
  `fontWriteLatin = fontWrite` → same look. Locked by `test:font-cjk-latin-ui`
  (rendered fonts via `CSS.getPlatformFontsForNode`).
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
- **CodeMirror long-code copy**: CodeMirror virtualizes long code blocks, so
  `.cm-line` contains only the visible window (often 30–65 lines). Whole-block
  copy must resolve the complete ProseMirror `code_block`; never fall back to
  DOM text, and never show success after a partial/failed resolution. Keep
  native CodeMirror selection copy untouched, then run `npm run test:issue-98-ui`
  for the 122-line whole-copy and 65-line partial-selection cases. Full report:
  `docs/long-code-copy-virtualization-regression.md`.
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
- **PDF visual fidelity**: PDF Studio renders the same final PDF Buffer that is
  saved to disk. Do not validate layout only from source HTML or print CSS.
  Body font size is a separate 8–24pt setting (11pt default); overall scale
  still scales the complete page, while headings, tables, code, and spacing
  remain relative to the body size.
  Table export preserves measured total width and column ratios, while
  `th/td > p` margins stay reset so document paragraph spacing cannot inflate
  rows. An empty cell is an empty `<p>` (the trailing-break is stripped), so
  `p:empty::after { content: "\\200B" }` keeps blank rows one line tall in
  both PDF and HTML export (`test:pdf-empty-table-rows-ui`). Follow [`docs/pdf-visual-fidelity-runbook.md`](./docs/pdf-visual-fidelity-runbook.md)
  for final-PDF X/Y coordinate checks, PNG rendering, regression commands, and
  handoff stop conditions.
- **PDF preview cancellation**: latest-request-only does not mean destroying a
  BrowserWindow during `printToPDF()`. Chromium can reject the Promise before
  its native print backend has recovered, causing the next request to fail with
  `Printing failed`. Let active printing finish, discard stale output, and wait
  for the worker's asynchronous cleanup before starting the latest request.
- **Document export subsystem** (PDF / HTML / Pandoc / AI): three independent
  output pipelines. PDF and HTML share the structured editor snapshot
  `{ html, headings, title, images }` from `editor-pdf-content.js`
  (`getPdfSource()`/`getExportSource()`) but have **separate templates and
  settings** — never paste PDF print CSS into the HTML template. Pandoc does
  **not** use the snapshot: it reads the active tab's raw Markdown only (source
  textarea live buffer, or `flushMarkdown()` in rich mode — never a stale React
  tab snapshot), and export must not change dirty/cursor/disk. See
  [`docs/document-export-architecture.md`](./docs/document-export-architecture.md).
- **Export snapshot fidelity** (2026-10-27): image blocks export as
  `<figure><img><figcaption>` (the caption was Crepe's `<input>`, a text box
  under every captioned image; read from the live input before the first
  await); code rows `.hm-code-line` need the template rules in BOTH
  templates (HTML had none: every line on one line); code gets the editor's
  oneDark colours as inline styles (`lib/export-code-highlight.js`, same
  @codemirror/language-data parser; ivory / white rules skipped for paper);
  HTML block math is `display: block math` (plain `block` left it
  left-aligned). Locked by `test:export-fidelity-ui`.
- **HTML export** (`html-export.js` + `html-document.js`): the main-process
  preview returns an opaque token; the saved file is the SAME bytes the token
  refers to (no re-render on save). Output is no-script: the snapshot strips
  dangerous nodes/attrs, the template ships a strict CSP, the renderer preview
  is a no-permission sandbox iframe. Latest-request-only like PDF.
- **Pandoc export** (`pandoc-export.js` + `pandoc-core.js` + `subprocess.js`):
  the executable is verified by absolute path + `--version`; the target format
  is a whitelist; args are built main-side; Markdown goes via stdin; `shell:
  false`; 2-min timeout. The source file's directory is passed as
  `--resource-path` so relative images resolve. Only the chosen executable
  path is persisted (`userData/document-tools.json`).
  Detection also reads `--list-extensions=gfm` (#167): Pandoc ≤ 2.10 rejects
  `gfm+tex_math_dollars` ("not supported for gfm", e.g. Ubuntu 22.04's 2.9),
  so those get plain `--from=gfm` (formulas as text) and a hint
  (`mathUnsupported`, `pandoc.oldMath`); 2.11+ keep `gfm+tex_math_dollars`.
  Checked with real 2.9.2.1 / 2.10 / 2.11 / 2.14 / 2.19 / 3.0 / 3.1 / 3.12
  (Windows too: 2.9.2.1 and 3.12.1 through the menu).
  Figures (2026-10-27, Typora parity — its docx/epub exports carry the
  rendered diagrams): Pandoc reads the source, so Mermaid / ```svg / an
  `<svg>` paragraph / a local `.svg` image reached Word as code or not at
  all. `lib/pandoc-figures.js` (renderer, lazy-loaded) finds them by mdast
  position and makes SVG data URLs (`renderMermaidForExport`,
  `svgCodeImage`: scripts dropped, intrinsic size); main
  (`pandoc-figures.js`) rasterizes each in an offscreen window as an <img>
  (foreignObject labels paint, scripts never run) at 2× with a 192-dpi pHYs,
  then replaces ONLY the rendered ranges (`pandoc-figures-core.js`
  validates offsets) — docx/odt/rtf via a temp resource dir (removed after),
  EPUB as a sized raw `<img>` (EPUB ignores DPI), LaTeX into
  `<name>-figures/` beside the .tex; MediaWiki / txt unchanged. Locked by
  `test:pandoc-figures` + `test:pandoc-figures-ui`. `txt` uses `--to=plain`
  (Pandoc wrote Markdown for .txt).
  Success dialog (`PandocExportStatus.jsx`): file name + folder, then 打开文件
  (focused, Enter) / 在文件夹中显示 / 关闭 (Esc). Nothing opens by itself.
  `pandoc:openResult` takes only 'file' | 'folder' — main opens the path it
  just wrote (`lastExportPath`), never one from the renderer; a failed or
  missing open keeps the dialog with the reason. Locked by
  `test:pandoc-export-ui` (fake `pandoc` script, stubbed shell).
- **AI Phase 0** (`src/shared/ai-contracts.js` + `src/main/ai/`): pure, no-UI,
  no-network contracts (`AiRequest`, `ProviderAdapter`, `ContextSnapshot` with
  sha256 revision, `ChangeProposal` with before-check + stale refusal). **Not
  user-facing yet** — future Provider/key/network/UI must not bypass revision
  validation and `ChangeProposal`. See
  [`docs/ai-vmark-phase-plan.md`](./docs/ai-vmark-phase-plan.md).
- **Export save-dir remembering** (`export-prefs.js` + `export-prefs-logic.js`):
  PDF/HTML/Pandoc save dialogs default to the source Markdown's folder, and the
  choice is remembered **per file** — the same file keeps its chosen folder, but
  a different file still defaults to its own folder (do NOT use a single global
  last-dir); untitled docs fall back to a global last dir. Persisted in
  `userData/export-prefs.json`. The pure decision logic is split into
  `export-prefs-logic.js` so `scripts/test-export-prefs.mjs` can lock the
  per-file semantics without Electron.
- **PDF density** (`PDF_DENSITY_VALUES` in `src/shared/pdf-options.js` +
  `pdf-print-styles.js`): a comfort/standard/compact preset. The 12 spacing
  rules (body line-height, para/heading/list/li/blockquote/figure/img/math/hr
  margins) are CSS vars (`var(--hm-pdf-*, literal)`); `standard`'s values ARE
  the pre-density literals, so the default renders identically — validate via
  the rendered PDF, **not a CSS string diff** (the string changes because of
  `var()`). Heading line-height (1.3), code (1.6) and table-cell (1.4)
  line-heights + the `th/td > p { margin:0 }` reset stay **hardcoded** (not
  density levers — protects table measurement + heading hierarchy). Note `em`
  margins do NOT scale with `line-height` (em is font-size-relative), so ALL
  spacing rules must be parameterized for uniform compactness. Persist only
  `densityPreset` (`settings.lastPdfDensityPreset`), **not the whole options
  bag** (header/footer/title/page-ranges are per-document and must not leak
  across docs). The live page-count estimate is the preview's real `numPages`,
  lifted via an `onPageCount` callback. Locked by `scripts/test-pdf-density.mjs`.

## Testing

There is no single `npm test` command. The repository has deterministic Node
tests plus hidden, isolated Electron/CDP UI sessions. Run `npm run build` before
focused tests and use `npm run test:ui-regression` for editor/PDF/UI changes;
the suite currently covers seven sessions plus standalone regressions. Input
rules and source-fidelity tests type one character at a time through
`scripts/lib/human-input.mjs`. See [`docs/development.md`](./docs/development.md).

Rich/source sync work: run the seeded fuzzer (`npm run fuzz:rich-source-ui`),
reproduce with `scripts/lib/probe-session.mjs`, and follow
[`docs/rich-source-fuzzing.md`](./docs/rich-source-fuzzing.md) (triage flow,
fixed families with root causes, prioritized open list). UI tests must wait
for the asynchronous source-mode switch before touching the textarea.

On macOS, scripting `osascript "tell application \"Electron\""` can launch the
generic `node_modules` Electron bundle. Automated regression must use
`scripts/lib/electron-test-app.mjs` in background mode; user handoff must rebuild,
install and verify the current `/Applications/HorseMD.app`.

## When in doubt

Read the matching doc in `docs/` before changing a subsystem — many non-obvious
behaviors (editor data flow, drag regions, watcher echo suppression, the
title-bar layout) are documented there with their root causes.
