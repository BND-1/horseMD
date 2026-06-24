# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-06-24

HorseMD becomes a Markdown document workspace with built-in AI assistance and
local Git management.

### Added
- **AI sidebar.** Open an AI chat from the top bar, start new conversations, and
  render assistant replies as Markdown.
- **AI provider settings.** Configure OpenAI-compatible endpoints and DeepSeek,
  fetch available models from the configured API, then choose the exact model
  manually.
- **Selection-based AI editing.** Ask AI to rewrite, format, summarize, or adjust
  only the selected Markdown range instead of replacing the whole document.
- **Git management sidebar.** View working tree and staged changes, stage /
  unstage files, discard single-file changes, write a commit message, and commit
  to the local repository.
- **Graphical commit history.** Show branch routes, branch labels, commit
  details, changed files, and side-by-side diff tabs for commits and worktree
  changes.
- **Branch actions.** Switch branches, create branches, delete branches with
  confirmation, create a branch from a commit, merge a commit into the current
  branch, and hard-reset the current branch to a selected commit.
- **Manual repository initialization.** Non-Git folders now show an explicit
  initialization action instead of silently creating a repository.

### Changed
- Removed mobile-focused project code and dependencies from this desktop branch.
- Improved source-control icons, discard-change affordances, branch popovers,
  and commit-message layout.
- Commit history now preloads changed-file lists, so expanding a commit can show
  files immediately without a second Git query.

## [0.3.0] - 2026-06-19

HorseMD adds a batch of editor and UI improvements, plus an important desktop
crash fix.

### Added
- **Adjustable font size.** A status-bar control sets the editor body font size
  (presets + fine-tune slider) — combined with the page-width control into one
  **Layout** button.
- **Document stats popover.** The word / character / reading-time counts now live
  in one status-bar button; open it for the full breakdown (words, characters,
  characters without spaces, reading time).
- **Outline follows the cursor.** The outline highlights — and scrolls to — the
  heading you're currently viewing (scrollspy), the way the file tree marks the
  open file.
- **File tree follows the open file** (#11). Opening or switching to a file
  auto-expands its parent folders and highlights / scrolls to it.

### Changed
- **Pasted images become real files, never lost** — pasting or dropping a
  screenshot into a saved document writes it into a sibling `./assets/` folder and
  inserts a short relative link; in an unsaved draft it's parked as a real file
  and moved into `./assets/` on first save (Typora-style). No more giant base64
  blobs in the Markdown, and no more screenshots vanishing after save & reopen.
- **Tidier status bar** — font-size + width merged into one **Layout** button;
  the counts merged into a **stats** button; the block-type switcher was removed
  (block type is still changeable via the floating badge, the selection toolbar,
  right-click, the slash menu, and Ctrl/Cmd+1–6 / Ctrl/Cmd+0).

### Fixed
- **Inline code "wouldn't stop"** (#10) — text typed after a closing backtick kept
  inheriting the inline-code style; the mark is now non-inclusive, so the caret
  leaves code on the next character (matching Typora).
- **Desktop white-screen crash** — a frozen `window.api` (contextBridge) made the
  desktop build crash on launch; feature capabilities are now exposed from the
  preload instead of assigned at runtime.

## [0.2.0] - 2026-06-14

A big feature release: image hosting, custom themes, diagrams & math, adjustable
page width, in-cell line breaks, an Intel macOS build, and a nicer update prompt.

### Added
- **Configurable image host** — a Typora-style custom upload command. Pasting,
  dropping, or uploading an image runs your command (e.g. `picgo upload`) and
  inserts the returned URL. Configured from a top-bar button (a dot marks it as
  active). Leave it empty to keep images local.
- **Custom themes** — drop a `.css` file (or a whole downloaded theme folder) into
  the themes folder and pick it from the status-bar theme menu, under a **Custom**
  section with **Open themes folder** / **Get more themes** (theme.typora.io). The
  editor exposes Typora's `#write` / `markdown-body` hooks so **Typora themes work
  directly**; subfolders are scanned, and relative `url(...)` assets (fonts/images)
  resolve correctly.
- **Mermaid diagrams** — ` ```mermaid ` code blocks render live as diagrams below
  the editable source (Mermaid is lazy-loaded only when a diagram is present).
- **LaTeX math** — inline `$…$` and block `$$…$$` render via KaTeX.
- **Adjustable editor width** — a status-bar control with preset segments
  (Narrow / Medium / Wide / Full) plus a fine-tune slider.
- **Line breaks inside table cells** — press Enter / Shift+Enter in a cell; it
  round-trips cleanly as `<br>` (GFM tables stay single-line, never corrupted).
- **Update prompt shows what's new** — the "new version available" toast now
  displays the GitHub release notes (auto-loaded), with a slim scrollbar for long
  notes.
- **Intel macOS build** — the macOS target now ships both Apple Silicon (arm64)
  and Intel (x64).
- A project [ROADMAP.md](./ROADMAP.md).

### Changed
- **Denser tables** — much tighter rows (cell paragraph margins removed, smaller
  padding/line-height) so a Markdown table no longer wastes vertical space.
- Redesigned the update toast (gradient icon, version pills, sectioned release
  notes).
- Website + README document the Intel download alongside Apple Silicon.

### Fixed
- **Table text overflow** — long content / inline code in a cell now wraps instead
  of overlapping the neighbouring column.
- **Long formulas no longer overlap** — display math scrolls within the column.
- **Clicking an image no longer draws a selection frame** — the tint overlay and
  the inline-image outline are removed (resize handle + caption remain the cue).
- **Switching theme no longer drops the page-width / custom-theme setting** —
  `applyTheme` preserves app-managed `hm-*` body classes.

### Internal
- New modules: `settings.js`, `customThemes.js`,
  `components/{ImageHostButton.jsx, editor-mermaid.js, editor-tablebreak.js}`.
- Editor exposes a `getMarkdown` API; theme injection scoped so a custom theme
  owns the writing area while the app chrome keeps its own styling.

## [0.1.7] - 2026-06-10

### Added
- **Split view** — two documents side by side, both fully editable. Open a tab
  into the right pane from its (or a file-tree row's) right-click menu, or toggle
  with the split button in the top bar. **Drag the divider** to resize; **click a
  pane, then a tab** to switch that pane's file (the focused pane is shown by its
  tab underline). The two panes are independent editors that never re-mount, and
  Save / Export act on whichever pane you're editing.
- **Unified right-click menus** — the tab menu and the sidebar file-tree menu now
  offer the same file actions: Copy Path, Copy Name, Reveal in Finder/Explorer,
  Open in Split, Rename, Duplicate, Export as PDF, Delete (plus Close / Close
  Others on tabs; New File / New Folder in the tree).
- **Copy feedback** — the code-block "Copy" button flashes a green ✓ and shows a
  brief "Copied" toast; its label is localized.
- **Heavy documents open instantly** — a Markdown file that would freeze the rich
  editor (a huge run of lines with no blank-line breaks, or > ~400 KB) opens in
  the fast plain-text editor, with a one-click **"Render as rich text"** to load
  the WYSIWYG view on demand.

### Changed
- **Windows installer: the install location is now selectable**, and uninstalling
  *or updating* only removes the files HorseMD shipped — any files you saved
  inside the install folder are left untouched.
- **Cleaner split UI** — a 1px hairline divider, a single faint ✕ (hover-tooltip)
  to close the split, and the focused pane marked by its tab's accent underline
  (the other pane's tab stays subtly underlined).

### Fixed
- **Crash on launch from the recursive file watcher.** A saved workspace that was
  a relative path (e.g. `"."`) or the filesystem root made the watcher recurse the
  whole filesystem — under Finder/launchd the CWD is `/`, so `"."` meant watching
  `/dev`, `/System/Volumes`, … — a flood of `EACCES`/`EAGAIN`/`EBUSY` that aborted
  the app on startup (often seen as an instant crash / black window). The watcher
  now only watches absolute paths, skips the root and system/device trees, doesn't
  follow symlinks, and swallows per-path errors; the renderer ignores a
  non-absolute restored workspace; launch args resolve to absolute (the app's own
  directory is never opened); and a process-level guard catches stray async errors.
- **Tab-menu "Rename" did nothing** — it used `window.prompt`, which Electron
  doesn't support; it now opens a small inline rename dialog.
- **Unsaved scratch / new tabs survive a restart** — untitled tabs with edits were
  silently lost on close; they're now persisted and restored (saved files are
  still reopened from disk).
- **Light-theme code-block selection was unreadable** (near-black-on-black); it now
  uses the soft accent highlight with legible syntax colors.
- **Code blocks no longer highlight the "active line"** on entry/first line — the
  caret alone marks the position.
- **The floating block badge (H1/H2/Text) no longer overlaps the block drag-handle**
  — it tucks to the handle's left so both stay visible.
- **Clicking a table cell no longer shows an out-of-place selection wireframe** — the
  hard blue node/cell outline is removed for tables (the soft cell-range fill stays);
  elsewhere the selected-node ring is a subtle theme accent.
- **Loading skeleton no longer overlaps already-rendered content** (it's cleared
  synchronously the moment content renders, before the heavy post-processing).
- **Typing lag in large / unsaved documents** — session state is no longer
  re-serialized to disk on every keystroke (debounced, flushed on close).
- Main-process update check uses Electron's `net.fetch` (Chromium stack) instead of
  Node's `fetch`, avoiding a c-ares abort on some unsigned-app launches.

### Internal
- Refactored `App.jsx` (1598 → ~1300) and `Editor.jsx` (992 → ~836): extracted pure
  helpers and leaf components (`find.js`, `paths.js`, `ui.js`,
  `components/{Welcome,WindowControls,UpdateToast,RenameModal}.jsx`,
  `components/editor-{html,images,copy}.js`) and deduplicated shared helpers. No
  behavior change.

## [0.1.6] - 2026-06-09

### Changed
- New/empty documents now start as an empty **Heading 1 plus an empty body
  paragraph** below it. The title is there if you want it, but you can skip it
  and start writing body text straight away (click the line below or press ↓).
  Previously the doc was *only* a forced H1, so you couldn't write body without
  first typing a title and pressing Enter.

### Fixed
- Creating / renaming / moving / duplicating to a name that already exists now
  shows a clear "name already exists" message instead of a raw `EEXIST` error,
  and never overwrites the existing file.

### Added
- **Loading skeleton** for large documents — pulsing gray placeholder bars while
  the editor parses/renders, so opening *or switching to* a big file isn't a
  frozen/blank pause. (Creation is deferred one paint so the skeleton actually
  shows before the parse blocks the main thread.) Small files never show it.
- **Double-click an image to view it enlarged** in a lightbox (click the backdrop,
  the ✕, or press Esc to close). Display-only — it never changes the document,
  and a single click still selects the image / edits its caption.
- **Home button** at the top of the activity bar (the app icon) — returns to the
  welcome/landing page while keeping open tabs mounted (clicking a tab goes back).
- **Version number** shown next to "HorseMD" on the welcome page, so you can tell
  which build you're running.
- **Raw HTML tables now render as tables** (like Typora). An HTML `<table>…</table>`
  written in the Markdown is shown as a real, theme-styled table instead of
  escaped source. The Markdown source is unchanged — it round-trips and saves as
  the original HTML (rendering is display-only; `<script>`/inline event handlers
  are stripped).

### Performance
- **Faster startup / session restore.** Restored tabs now mount their rich
  editor lazily — only the active document spins up an editor on launch instead
  of every restored tab parsing its whole document at once. Editors stay mounted
  after first activation, so tab switches remain instant.
- **Smoother typing in large documents.** The floating block-level badge now
  coalesces its layout measurements to one per animation frame (it previously
  forced a synchronous reflow on every caret move / keystroke), and the
  selection-toolbar observer only re-scans when DOM nodes are actually added
  (debounced per frame) instead of on every edit.

### Fixed
- **Closing the window now warns about unsaved changes** (macOS traffic light,
  the Windows close button, Cmd/Ctrl+Q) — previously only closing a tab did.
- Image **caption** text ("Write image caption") is now localized and follows
  the zh/en switch.

## [0.1.5] - 2026-06-08

### Added
- File tree: **drag and drop** files/folders into another folder to move them.
- File tree: the collapse-all button now **toggles** between collapse-all and
  expand-all (recursively expands every subfolder), with a matching icon.
- Selection toolbar buttons now show **tooltips** (Bold, Italic, Strikethrough,
  Inline code, Link).
- Always-visible **collapse / expand sidebar** toggle in the activity bar (the
  icon flips to an "expand" affordance when collapsed).

### Changed
- File-tree typography: larger, non-uppercase folder-name header and slightly
  larger row text for better legibility (especially CJK names).

### Fixed
- **Find (Ctrl+F) rewritten** to search only the editor content via the CSS
  Custom Highlight API: it no longer matches the text typed in the find box, and
  next/previous are instant (no IPC round-trip). Shows a live `x/total` count.
- **Uninstall no longer deletes user files.** The uninstaller now removes only
  the files HorseMD installed, so a document saved inside the install folder
  (e.g. a Markdown note next to the app) is preserved instead of being wiped by
  a blanket recursive delete. The install location is also fixed to a dedicated
  per-user folder so the app can't be installed into a folder of your own files.
- The title bar always keeps a draggable area to move the window, even when many
  open tabs fill the whole tab strip.

## [0.1.4] - 2026-06-08

### Added
- Floating **block-level badge** that tracks the caret, naming the current block
  (H1…H6 / 正文) beside the text.
- Sidebar right-click: **Duplicate** a file, and **Export as PDF**.
- Custom Windows caption buttons (minimize / maximize / close) with hover states
  (close turns red), replacing the native overlay.
- Explorer **"Open with HorseMD"** entry on folders — opens a directory as a
  workspace; the app now accepts a folder path on launch.
- **Notify-only update check**: on launch, looks up the latest GitHub release and
  shows a dismissible "new version available" toast.
- Inline **confirm (✓) / cancel (✗)** buttons on the create & rename fields, and
  an "empty folder" hint when an expanded directory has nothing to list.

### Changed
- Source/rich toggle now **keeps the scroll position** and no longer rebuilds the
  background editors, so switching is much faster.
- Shorter executable description ("HorseMD Markdown Editor") so the Explorer
  "Open with" name isn't a long sentence.

### Fixed
- New file/folder creation now commits on blur (clicking away no longer loses the
  typed name).
- The unsaved-close confirm dialog and a couple of error messages are now
  localized (zh/en).

## [0.1.3] - 2026-06-07

### Fixed
- Open files now reliably auto-refresh when changed by another program: the
  single-file watcher polls (surviving "atomic replace" saves used by many
  editors/tools), and the editor remounts on reload so the new content actually
  shows.

## [0.1.2] - 2026-06-06

### Added
- Export the current document to **PDF** (File → Export as PDF…, `Ctrl/Cmd+Shift+E`,
  or the command palette). Renders a clean, print-styled copy without editor
  chrome (code-block toolbar, table handles, etc.).

### Changed
- Writing font in the editor now matches the website — a sans-serif stack
  (Helvetica Neue / PingFang SC …) instead of the previous serif.
- Status bar now keeps the right-side controls (block/source toggles, theme,
  language, GitHub) fixed and visible when the window narrows — the file path
  collapses (ellipsis) instead of the buttons being hidden or pushed off-screen.

### Fixed
- New-file naming overwrote the input when typing digits (the name was reselected
  on every keystroke) — the name is now preselected once.
- Editor placeholder now follows a language switch live (was baked in at create).
- Opening a moved/deleted file no longer dumps a raw IPC error — the dead entry
  is removed from Recent with a friendly message; session restore skips missing
  files silently.

## [0.1.1] - 2026-06-05

### Added
- Top-bar `+` button to create a new file, and a GitHub link in the status bar.
- Plain-text files (`.txt`) open in a fast plain-text editor instead of the
  Markdown WYSIWYG.
- macOS packaging (dmg + zip) and a native macOS title-bar layout.
- Bilingual README (English + 简体中文) with screenshots and a theme gallery; `CLAUDE.md`.
- MIT `LICENSE`, CI build check + tag-triggered release packaging, `CONTRIBUTING.md`,
  `SECURITY.md`, and issue templates.
- Explicit Electron security flags (`contextIsolation`, `nodeIntegration`) and a navigation guard.

### Fixed
- Status-bar theme/language menus were clipped by `overflow:hidden` and looked
  unclickable — they now open correctly.
- Large `.txt` files no longer hang the editor (they bypass Markdown parsing).
- Rename now preselects the filename without its extension, like new-file.

## [0.1.0] - 2026-06-05

### Added
- Initial release: tabbed, Typora-style WYSIWYG Markdown editor.
- Folder workspace with file-tree sidebar, command palette, outline panel.
- Dark/light themes, session restore, single-instance file association.
- Windows NSIS installer and macOS dmg/zip packaging.

[Unreleased]: https://github.com/BND-1/horseMD/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/BND-1/horseMD/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/BND-1/horseMD/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/BND-1/horseMD/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/BND-1/horseMD/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/BND-1/horseMD/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/BND-1/horseMD/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/BND-1/horseMD/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/BND-1/horseMD/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BND-1/horseMD/releases/tag/v0.1.0
