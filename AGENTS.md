# Repository Guidelines

## Project Structure & Module Organization

HorseMD is an Electron + Vite + React Markdown editor with a shared renderer for desktop and Capacitor mobile builds.

- `src/main/index.js`: Electron main-process lifecycle, window, IPC assembly, menus, assets, and update checks.
- `src/main/filesystem.js`, `watchers.js`, `documents.js`: file operations, watchers, dialogs, and PDF export.
- `src/preload/index.js`: secure `window.api` bridge exposed to the renderer.
- `src/renderer/src/`: React app, Milkdown editor, hooks, shell components, themes, i18n, platform shim.
- `src/renderer/src/components/Editor.jsx`: Crepe/ProseMirror editor wrapper; keep new editor features in focused `editor-*.js` helpers when possible.
- `src/renderer/src/hooks/` and `src/renderer/src/lib/`: file ops, lifecycle, outline, find/replace, menus, and review actions.
- `docs/`: architecture, features, development workflow, mobile notes, and manual testing.
- `scripts/`: lightweight verification and CDP helpers.
- `website/`: static product/download homepage; `guide/`: isolated VitePress user tutorial site.
- `build/`, `icons/`, `android/`, `ios/`: packaging assets and mobile shells.

## Build, Test, and Development Commands

```bash
npm install
npm run dev
npm run build
npm start
npm run dist
npm run build:mobile
npm run test:source-map
npm run guide:check
node scripts/test-strike-guard.mjs
```

- `npm run dev`: starts Electron/Vite hot reload.
- `npm run build`: builds main, preload, and renderer into `out/`; CI uses this.
- `npm start`: runs the built app.
- `npm run dist`: creates the host-platform installer via `electron-builder`.
- `npm run build:mobile`: builds the Capacitor renderer into `dist-mobile/`.
- `npm run test:source-map`: runs Markdown raw-offset ↔ ProseMirror mapping tests for tables, duplicate text, code, images, lists, and HTML.
- `npm run guide:check`: validates tutorial metadata, versions, links, assets, screenshot privacy/dimensions, and builds the guide site.
- `node scripts/test-strike-guard.mjs`: runs CriticMarkup strike regression checks.

## Coding Style & Naming Conventions

Use ES modules, React functional components, two-space indentation, single quotes, and no semicolons. Components use `PascalCase.jsx`; hooks use `useName.js`; editor helpers use descriptive `editor-*.js` names. No formatter or linter is enforced, so match nearby code. Avoid adding large logic blocks to `App.jsx` or `Editor.jsx`; prefer small modules under `hooks/`, `lib/`, or `components/editor-*.js`.

## Testing Guidelines

There is no single `npm test` command. Run `npm run build` before PRs. For editor/review logic, add or update focused scripts under `scripts/`. For UI changes, follow `docs/manual-test-checklist.md`; CDP helpers are in `docs/development.md`.

User-facing changes must update the matching `guide/` page. Tutorial screenshots must come from a rebuilt and freshly installed current app using an isolated profile; follow `docs/user-guide-maintenance.md`. Never publish screenshots containing personal paths or stale UI.

## Commit & Pull Request Guidelines

History uses concise subjects such as `feat(#38): ...`, `fix(site): ...`, `docs: ...`, `chore: ...`, and `refactor: ...`. Keep commits focused and imperative. PRs should describe the change, link issues, include UI screenshots, mention desktop/mobile impact, and add `CHANGELOG.md` entries for user-facing changes.

## Security & Configuration Tips

Keep Electron renderer access behind `window.api`; do not enable Node integration. Do not commit signing keys, keystores, or local config such as `android/key.properties`. When adding native capabilities, update both desktop preload and the Capacitor shim or gate the UI with `window.api.capabilities`.

## Operational Notes From CLAUDE.md

Use this section as the short, high-signal handoff for AI agents. Start with `docs/ai-handoff.md` for the current project state, user working style, risk map, website/guide ownership, and verification matrix. `CLAUDE.md` and the rest of `docs/` contain deeper history and root-cause writeups.

### Cross-Platform Contract

- Desktop and mobile share the renderer. Desktop gets `window.api` from `src/preload/index.js`; mobile gets the same contract from `src/renderer/src/platform/capacitor-api.js`.
- Platform-specific renderer behavior should go through `window.api.platform`, `window.api.capabilities`, and `.app.is-mac` / `.app.is-win` / `.app.is-linux` CSS classes.
- Keep title-bar paths explicit: macOS uses `hiddenInset` and traffic-light spacing; Windows and Linux use `window:*` IPC with separate Windows and GTK renderer styles.
- Shortcuts should generally support both Ctrl and Cmd via `ctrlKey || metaKey`.
- If adding native capabilities, update both preload and Capacitor shim, or hide/gate the feature via capabilities.

### Editor Invariants

- `Editor.jsx` is the Crepe/ProseMirror lifecycle owner. Avoid adding large new logic there; prefer focused `components/editor-*.js` helpers.
- Get the ProseMirror view via `crepe.editor.ctx.get(editorViewCtx)`. Do not use `crepe.editor.view`; it is undefined for this Milkdown version.
- Register `crepe.on(markdownUpdated)` before `crepe.create()`, otherwise user edits do not reach App state and saves can write stale content.
- Only real user edits should mark the tab dirty. Programmatic content restore, source/rich sync, and initialization must not trigger dirty state.
- Add Milkdown node views by appending to `nodeViewCtx`; do not set `editorViewOptionsCtx.nodeViews`, which overwrites component node views such as images, CodeMirror, tables, and lists.
- Raw ProseMirror plugins and keymaps go through `prosePluginsCtx`; `crepe.editor.use(...)` is for Milkdown features/schema/input rules.
- Keep rich editors lazy-mounted: a rich tab is created on first activation, then kept mounted. Do not reparent panes or remount Crepe casually.

### Source, Textarea, And Large Documents

- Markdown files (`.md`, `.markdown`, `.mdx`) use rich editing unless classified as heavy. Plain text files with paths use the textarea.
- Heavy docs are detected in `paths.js` and default to textarea as a fast-open path; the user can opt into rich mode per tab.
- Source-mode textareas are intentionally uncontrolled. Keep the `liveContentRef` / `commitLive` flow intact; do not convert them to controlled React inputs.
- The source/rich state machine is owned by `hooks/useSourceModeSwitch.js`; `App.jsx` supplies stable refs and `EditorArea.jsx` owns rendering only.
- Source/rich switching depends on two independent intents: caret position and reading viewport. Editing toggles follow a visible caret; reading toggles preserve viewport.
- For the current mode-switch fix, Crepe must stay mounted when source mode is shown. Only sync source back into rich when source text was actually edited.
- Do not replace source/rich mapping with plain keyword matching. The primary caret path is block-aware Markdown raw-offset mapping; global visible-character positions and snippets/context are fallback only.
- Keep `scrollAnchor.js` as the stable public facade. Implement visible-stream, caret, viewport, and source-heading changes in the focused `mode-*.js` modules and preserve the facade exports.

### Performance-Sensitive Areas

- Avoid per-scroll full-document layout reads. `useOutline.js` uses cached heading offsets so scrollspy stays reflow-free.
- `content-visibility`, `contain-intrinsic-size`, and `overflow-anchor` interact tightly in large docs. Read `docs/performance-large-doc.md` before changing these styles.
- CodeMirror code blocks are eager-mounted via `editor-codeblock-eager.js` to prevent height deltas and scroll jumps near code blocks.
- Large image-dense documents are the real regression test for scroll/caret fixes; small docs are insufficient.

### PDF Export Invariants

- PDF export uses `getPdfSource()` structured HTML/headings, not a clone of the live editor DOM.
- Sidebar export waits for the per-tab editor API readiness signal; do not restore fixed polling delays.
- Main-process preview generation is latest-request-only per renderer. New settings cancel stale hidden-window work.
- Keep PDF temporary documents script-free through CSP and retain Electron's default web security policy.
- A printed contents page and the embedded PDF navigation outline are independent features.
- Display LaTeX blocks are preview-backed CodeMirror blocks in the editor, but PDF export must print rendered MathML, not the raw `$$...$$` source or editor controls. Keep `scripts/test-pdf-latex-ui.mjs` in the UI regression matrix.

### Feature-Specific Notes

- Review parsing lives in `reviewMarkup.js`; plugin state, decoration scanning, and card DOM live in `editor-review.js`, `editor-review-decorations.js`, and `editor-review-card.js`. Protect all four with focused script and real UI tests when changed.
- Find/replace uses the CSS Custom Highlight API scoped to editor content, not `window.find`.
- Mermaid uses Crepe CodeMirror preview configuration; do not replace it with a custom widget decoration unless there is a clear reason.
- Table-cell line breaks round-trip as `<br>` inside table cells; serializing them as normal newlines corrupts GFM tables.
- Image handling supports custom command/PicGo/local assets/base64 fallback. Empty image-host command must not intercept paste/drop into dead blob URLs.
- Renderer CSP intentionally allows `img-src http:` for local image hosts and PicGo-style HTTP URLs.

### Watchers, Session, And State

- File watchers must reject relative or restricted roots and must keep error handlers; watching `/` or system volumes can crash or flood the app.
- Main-process network calls should use Electron `net.fetch`, not Node global `fetch`.
- Session state uses `localStorage["minimd.session.v1"]`; preferences use `localStorage["horsemd.settings.v1"]`; onboarding and update-dismissal have separate keys.
- Settings tabs are transient and should not be persisted as document tabs.
- Unsaved scratch tabs persist through session restore and should remain marked dirty.
- Multi-root workspace state and directory watchers belong to `hooks/useWorkspace.js`; Sidebar tree loading belongs to `hooks/useSidebarTree.js`.

### Packaging And Verification

- Run `npm run build` before handing off code changes. Use `npm run build:mobile` for shared-renderer or platform-contract changes.
- `npm run dist` builds installers for the host OS. For fast local macOS testing, `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir` creates an unsigned unpacked app.
- Linux releases are `amd64.deb` files built on an Ubuntu runner. Validate them with `dpkg-deb --info` and real install/launch/file-association/window-control checks; a successful macOS cross-build exit code does not prove the deb is valid.
- The tag workflow explicitly uploads Linux packages with `gh release upload --clobber` after validation because electron-builder may skip draft publishing when the target Release already exists as published.
- Release versions must be monotonically greater than every build that may have been distributed for testing. Do not publish a lower "clean" version after internal builds such as `0.5.29`; auto-update compares semver, so `0.5.5` is treated as older than `0.5.29` and will not be offered.
- Before starting each distinct new feature, increment the test package to the next minor version. Keep follow-up fixes for that feature on the same version so users can identify the current test build reliably.
- When asking the user to manually test, always rebuild and install the current source first. Never ask the user to test an older installed app or a stale artifact; explicitly verify the installed app was produced after the latest relevant code change.
- When handing a macOS build to the user for manual testing, do not only overwrite `/Applications/HorseMD.app`. First kill any running HorseMD/Electron processes, then copy the new app, clear quarantine, launch it, and verify the running process points at `/Applications/HorseMD.app` with the intended document. If a specific fix has a marker string, verify `/Applications/HorseMD.app/Contents/Resources/app.asar` contains it before telling the user to test. This avoids macOS reusing an old app process after a reinstall.
- macOS unsigned app launch may need `xattr -dr com.apple.quarantine /Applications/HorseMD.app`.
- CDP test scripts require launching Electron with `--remote-debugging-port=9222`; with multiple mounted tabs, select visible `.ProseMirror` nodes via `offsetParent`.
- The manual regression baseline is `docs/manual-test-checklist.md`; mode-switch, save, find/replace, review, settings, and large-doc behavior are high-priority checks.

### Refactor Guidance

- See `docs/editor-refactor-strategy.md` before refactoring `Editor.jsx`.
- Preferred extraction order: image/resource persistence, plugin configuration, DOM bindings, public Editor API, then final Editor.jsx cleanup.
- Keep each refactor step behavior-preserving, separately committed, and verified with the smallest relevant test set plus `npm run build`.
