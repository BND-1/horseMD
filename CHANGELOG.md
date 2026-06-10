# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.7] - 2026-06-10

### Added
- **Split view** — show two documents side by side, both fully editable. Open a
  tab into the right pane from its right-click menu ("Open in Split"), or toggle
  with the split button in the top bar; close it with the ✕ on the right pane.
  The two panes are independent editors (no re-mount when toggling), and Save /
  Export act on whichever pane you're editing.
- **Tab right-click menu** — copy the file path, copy the file name, reveal the
  file in Finder/Explorer, open it in a split pane, close, or close others.
- **Copy feedback** — the code-block "Copy" button now flashes a green ✓ and a
  brief "Copied" toast, so the click clearly registers. (The button label is also
  localized.)

### Fixed
- **Crash on launch from the recursive file watcher.** If the saved workspace was
  a relative path (e.g. `"."`) or the filesystem root, the watcher recursed the
  whole filesystem — under Finder/launchd the working directory is `/`, so `"."`
  meant watching `/dev`, `/System/Volumes`, … — producing a flood of
  `EACCES`/`EAGAIN`/`EBUSY` errors that aborted the app on startup. The watcher
  now only watches absolute paths, skips the filesystem root and system/device
  trees, doesn't follow symlinks, and swallows per-path errors; the renderer
  ignores a non-absolute restored workspace; and a process-level guard keeps any
  stray async error from taking the app down.
- **Unsaved scratch / new tabs now survive a restart.** Untitled tabs with edits
  were silently lost when HorseMD closed; they're now persisted and restored on
  the next launch (saved files are still reopened from disk).
- **Code-block text selection is readable on the light themes.** Selecting text
  inside a code block previously rendered near-black-on-black; it now uses the
  soft accent highlight with legible syntax colors.
- **Typing lag in large / unsaved documents.** Session state was re-serialized
  and written to disk on every keystroke; it's now debounced (and flushed on
  close), so editing big documents stays smooth.

### Added (more)
- **Resizable split** — drag the divider between the two panes to change their
  ratio.
- **Unified right-click menus.** The tab menu and the sidebar file menu now offer
  the same file actions — Copy Path, Copy Name, Reveal, Open in Split, Rename,
  Duplicate, Export as PDF, Delete — so you get the same options wherever you
  right-click a file.

### Changed
- **Windows installer: the install location is now selectable**, and uninstalling
  (or updating) only removes the files HorseMD shipped — any files you saved
  inside the install folder are left untouched.

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

[Unreleased]: https://github.com/BND-1/horseMD/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/BND-1/horseMD/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/BND-1/horseMD/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/BND-1/horseMD/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/BND-1/horseMD/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/BND-1/horseMD/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/BND-1/horseMD/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BND-1/horseMD/releases/tag/v0.1.0
