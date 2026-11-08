// An empty list item is spelled `-` by the source reprint (the product
// path) and `- ` by the older fallback writers: both read back as the same
// empty item. Tests that compare source bytes on both paths compare with the
// blanks after a marker-only line removed (`- `, `  * `, `1. `). Not after a
// checkbox: `- [ ]` without the blank is text, not a task.
export const tightMarkers = (text) => typeof text === 'string'
  ? text.replace(/^([ \t>]*(?:[-*+]|\d{1,9}[.)]))[ \t]+(?=\r?$)/gm, '$1')
  : text
