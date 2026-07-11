// Mode-switch anchors for rich↔source (#28 scroll / #41 caret).
//
// Two INDEPENDENT anchors, each restored without the other fighting it:
//   - CARET   : the text the caret sits on (capture → restore the selection).
//   - VIEWPORT: the text at the top of the scroll area (capture → restore the
//               scrollTop). This is the user's READING position, which is NOT
//               the caret when the user scrolled away to read.
//
// Why two anchors: a single caret anchor + scrollIntoView (the v0.5.25 root
// fix) yanked the viewport to the caret, so VIEWING with the caret off-screen
// made the content jump ("内容漂移"). The earlier #28 dual system fought itself
// because its SCROLL anchor was a coarse heading/ratio while the CARET anchor
// was a precise snippet — they landed on different spots. Here BOTH anchors are
// precise snippets, and they never interact: the caret restore only sets the
// selection (no scroll), the viewport restore only sets scrollTop. Order in the
// caller: caret first, then viewport (so the viewport scroll wins outright).
//
// The primary caret coordinate is a block-aware Markdown raw offset. Global
// visible-char positions and snippets remain fallbacks for structures that do
// not have an exact source position. This file is intentionally only a stable
// public facade; implementations live in the focused mode-* modules below.
export { parseSourceHeadings, scrollSourceToHeading } from './mode-source-headings.js'
export {
  captureRichCaret,
  captureSourceCaret,
  isRichCaretVisible,
  restoreRichCaret,
  restoreSourceCaret
} from './mode-caret-anchor.js'
export {
  captureRichViewport,
  captureSourceViewport,
  restoreRichViewport,
  restoreSourceViewport
} from './mode-viewport-anchor.js'
