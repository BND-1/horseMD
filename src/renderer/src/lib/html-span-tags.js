// Inline HTML tags edited as formatted text (the `html_span` mark,
// components/editor-html-span.js): phrasing tags whose content is plain
// formatted text. Shared with the source reprint's inline map (pure module).
// Not here: `<a>` (a link), `<mark>` (the highlight colours own it), `<img>`,
// ruby — they stay raw html.
export const HTML_SPAN_TAGS = [
  'font', 'span', 'kbd', 'u', 'ins', 'del', 's', 'strike', 'b', 'i', 'strong', 'em',
  'sub', 'sup', 'small', 'big', 'samp', 'var', 'cite', 'dfn', 'abbr', 'q', 'tt', 'time', 'bdi', 'bdo'
]
const TAGS = HTML_SPAN_TAGS.join('|')
// `<kbd …>` / `</kbd>` at the start of a string.
export const HTML_SPAN_OPEN_TAG_RE = new RegExp(`^<(?:${TAGS})(?=[\\s>])[^>]*>`, 'i')
export const HTML_SPAN_CLOSE_TAG_RE = new RegExp(`^</(?:${TAGS})\\s*>`, 'i')
