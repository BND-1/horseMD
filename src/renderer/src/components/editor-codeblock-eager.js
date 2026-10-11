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
// BLOCK-COUNT CAP (issue #126, redis reference doc): eager mounting creates
// one live CodeMirror per fenced block, all at parse time. A 333k-char doc
// with 394 fences slid UNDER the heavy-doc textarea threshold (>400k chars)
// and wedged the renderer at 200%+ CPU with ~1GB RSS on open. Documents whose
// fenced-block count exceeds EAGER_CODE_BLOCK_LIMIT fall back to Milkdown's
// native lazy mount (the #25 jump can still occur on those docs — strictly
// better than an unusable editor). The mode is chosen per editor instance
// before Crepe parses (chooseCodeBlockMountMode), and blocks created later
// inherit the live mode.
//
// WHY A PROTOTYPE MODIFICATION (not a nodeView override): the clean path is
// architecturally blocked in this Milkdown version — `nodeViewCtx` can ADD new
// node views (html/frontmatter) but cannot OVERRIDE an existing component view
// (`code_block` is registered via `$view` and wins; verified empirically). And
// `editorViewOptionsCtx.nodeViews` is spread LAST into EditorView, so setting it
// would overwrite EVERY component node view (image-block, tables, lists) — not
// viable. CodeMirrorBlock IS exported, so we modify its prototype directly: a
// SURGICAL change to the mount lifecycle, in our code, documented here. If
// Milkdown later adds a config flag (or renames these methods), revisit.
//
// `destroy()` cleans up directly (app.unmount + cm.destroy, NOT via teardown),
// so block deletion is unaffected.
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
const originalRenderPlaceholder = proto.renderPlaceholder

// Eager by default (#25); block-count-heavy documents switch to lazy before
// their Crepe instance parses (chooseCodeBlockMountMode).
let eagerMountEnabled = true

export const setCodeBlockEagerMount = (enabled) => {
  eagerMountEnabled = enabled !== false
}

// Count fenced-code blocks (opening fence lines / 2; tolerates indented
// fences and both markers).
export const countFencedCodeBlocks = (markdown) => {
  if (!markdown) return 0
  const fenceLines = String(markdown).match(/^[ \t]{0,3}(`{3,}|~{3,})/gm)
  return Math.floor((fenceLines ? fenceLines.length : 0) / 2)
}

// Beyond this many fenced blocks the eager mode's cost (one live CodeMirror
// per block, all mounted at parse) outweighs the #25 stability win.
export const EAGER_CODE_BLOCK_LIMIT = 40

export const chooseCodeBlockMountMode = (markdown) =>
  setCodeBlockEagerMount(countFencedCodeBlocks(markdown) <= EAGER_CODE_BLOCK_LIMIT)

// (1) Mount the CodeMirror editor EAGERLY at construction instead of showing a
//     placeholder + waiting for the IntersectionObserver. renderPlaceholder() is
//     called exactly once, in the constructor, AFTER node/view/config/loader/
//     languageConf/readOnlyConf/forwardUpdate are all assigned — so
//     initializeCodeMirror() (idempotent via its `initialized` guard) is safe to
//     call here, and the observer's later "isIntersecting" callback is a no-op.
proto.renderPlaceholder = function adaptiveRenderPlaceholder(...args) {
  if (!eagerMountEnabled) return originalRenderPlaceholder.apply(this, args)
  this.initializeCodeMirror()
}

// (2) Never tear the editor down once mounted → its height never reverts to
//     the placeholder (the source of the delta). destroy() still cleans up
//     directly, so this doesn't leak on block deletion. Applies to lazy mode
//     too: the 5s off-screen teardown was the only timer-driven layout
//     mutation in the scroll path — during trackpad momentum its height
//     reverts kept the content shifting after the user stopped scrolling
//     (user report on the 394-block doc). Memory stays bounded by the blocks
//     actually visited.
proto.scheduleTeardown = function adaptiveScheduleTeardown() {
  /* intentional no-op in BOTH modes — keep mounted so height stays stable (#25) */
}
