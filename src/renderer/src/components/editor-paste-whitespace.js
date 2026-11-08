// External HTML may encode a visible line break as a text newline plus CSS,
// not a BR node. ProseMirror's normal DOM parser collapses those newlines.
// Work in the detached clipboard fragment only: no computed styles, network
// stylesheet loading, active DOM mutation or Markdown source normalization.
const PRESERVE_BREAKS = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces'])
const SKIP = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'SVG', 'MATH'])

export function materializeStyledPasteBreaks(root) {
  let count = 0
  // ProseMirror's DOM parser keeps whitespace below any element whose style
  // says `pre…` and never drops that for a descendant reset to `normal`: the
  // newline in `<p style="white-space:pre-wrap">a<span
  // style="white-space:normal">\nb</span></p>` became a hard break, though the
  // browser shows `a b`. Text there is collapsed the way the browser does.
  const visit = (parent, inherited = false, pmPreserves = false) => {
    if (parent.nodeType === 1 && (SKIP.has(parent.tagName) || parent.hasAttribute('data-pm-slice'))) return
    const declaration = parent.style?.whiteSpace?.toLowerCase() || ''
    // white-space is inherited; initial/revert/normal/nowrap reset preservation.
    const preserve = !declaration || declaration === 'inherit' || declaration === 'unset'
      ? inherited
      : PRESERVE_BREAKS.has(declaration)
    const pmPre = pmPreserves || /pre/.test(declaration)
    for (const child of [...parent.childNodes]) {
      if (child.nodeType === 1) {
        visit(child, preserve, pmPre)
      } else if (child.nodeType === 3 && pmPre && !preserve && /[\t\r\n]|  /.test(child.nodeValue)) {
        child.nodeValue = child.nodeValue.replace(/[ \t\r\n]+/g, ' ')
      } else if (child.nodeType === 3 && preserve && /[\r\n]/.test(child.nodeValue)) {
        const parts = child.nodeValue.split(/\r\n?|\n/)
        const fragment = child.ownerDocument.createDocumentFragment()
        parts.forEach((part, index) => {
          if (index) {
            const br = child.ownerDocument.createElement('br')
            fragment.appendChild(br)
            count += 1
          }
          if (part) fragment.appendChild(child.ownerDocument.createTextNode(part))
        })
        child.replaceWith(fragment)
      }
    }
  }
  visit(root)
  return count
}
