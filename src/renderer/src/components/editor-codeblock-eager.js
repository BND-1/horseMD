// Root-fix for issue #25 (code-block "page jump" on scroll/selection).
//
// Milkdown's code-block node view (CodeMirrorBlock in @milkdown/components/
// code-block) LAZY-MOUNTS its CodeMirror editor via a shared IntersectionObserver
// (rootMargin 200px): a plain <pre> placeholder while off-screen, the real
// CodeMirror EditorView only when the block scrolls into view, and a TEAR-DOWN
// after 5s off-screen. The placeholder↔mounted HEIGHT DELTA (measured ~127px on
// a 5-line block) is what scroll-anchoring can't absorb once the editor has a
// selection — Chromium disables overflow-anchor while a contenteditable has a
// selection (to protect it), so the delta surfaces as "scroll to a code block,
// stop, select → the page jumps". overflow-anchor:auto (base .editor-scroll)
// fixed the pure-scroll-stop case but NOT the selection case.
//
// ROOT FIX: make CodeMirrorBlock mount EAGERLY (no placeholder) and NEVER tear
// down, so every code block's height is stable at all times → no delta for
// anchoring (or the selection/anchor interaction) to mishandle → no jump, pure
// scroll OR selection.
//
// WHY A PROTOTYPE MODIFICATION (not a nodeView override): the clean path is
// architecturally blocked in this Milkdown version — `nodeViewCtx` can ADD new
// node views (html/frontmatter) but cannot OVERRIDE an existing component view
// (`code_block` is registered via `$view` and wins; verified empirically). And
// `editorViewOptionsCtx.nodeViews` is spread LAST into EditorView, so setting it
// would overwrite EVERY component node view (image-block, tables, lists) — not
// viable. CodeMirrorBlock IS exported, so we modify its prototype directly: a
// SURGICAL change to TWO lazy-mount methods, in our code, documented here — not
// the global IntersectionObserver hack, not a node_modules edit. If Milkdown
// later adds a config flag (or renames these methods), revisit.
//
// Trade-off: CodeMirror editors for every code block are created at parse time
// (one-time open cost). Fine for typical docs; the heavy-doc textarea fallback
// (>400k chars / >50k lines, paths.js isHeavyDoc) covers extreme cases. All
// CodeMirrorBlock behavior is preserved (language detection, copy button, mermaid
// renderPreview chain, in-block search) — only the mount lifecycle changes.
// `destroy()` cleans up directly (app.unmount + cm.destroy, NOT via teardown), so
// block deletion is unaffected.
import { CodeMirrorBlock } from '@milkdown/components/code-block'

// Guard against Milkdown API drift: if a future @milkdown/components bump
// renames/removes these hooks, the patch silently stops applying (lazy-mount
// returns) — surface that so a version bump doesn't quietly re-introduce #25.
if (
  typeof CodeMirrorBlock?.prototype?.renderPlaceholder !== 'function' ||
  typeof CodeMirrorBlock?.prototype?.initializeCodeMirror !== 'function' ||
  typeof CodeMirrorBlock?.prototype?.scheduleTeardown !== 'function'
) {
  // eslint-disable-next-line no-console
  console.warn('[horsemd] code-block eager-mount patch: CodeMirrorBlock API changed — #25 jump may return.')
}

const proto = CodeMirrorBlock.prototype

// (1) Mount the CodeMirror editor EAGERLY at construction instead of showing a
//     placeholder + waiting for the IntersectionObserver. renderPlaceholder() is
//     called exactly once, in the constructor, AFTER node/view/config/loader/
//     languageConf/readOnlyConf/forwardUpdate are all assigned — so
//     initializeCodeMirror() (idempotent via its `initialized` guard) is safe to
//     call here, and the observer's later "isIntersecting" callback is a no-op.
proto.renderPlaceholder = function eagerRenderPlaceholder() {
  this.initializeCodeMirror()
}

// (2) Never tear the editor down once mounted → its height never reverts to the
//     placeholder (the source of the delta). destroy() still cleans up directly,
//     so this doesn't leak on block deletion.
proto.scheduleTeardown = function noOpTeardown() {
  /* intentional no-op — keep mounted so height stays stable (#25) */
}
