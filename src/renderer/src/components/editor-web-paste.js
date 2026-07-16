// Browser editors often use layout-only <section>/<div> elements as visual
// paragraphs. ProseMirror ignores those unsupported wrappers, which can merge
// several copied paragraphs into one. Convert only leaf block wrappers; real
// structures such as lists, tables, quotes and nested layout groups stay intact.
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'UL'
])

const STRUCTURED_WEB_SELECTOR = [
  'article', 'section', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'ul', 'ol', 'li', 'table', 'figure'
].join(',')

const hasContent = (element) =>
  !!element.textContent?.trim() || !!element.querySelector('img, video, audio, br')

const hasDirectBlockChild = (element) =>
  [...element.children].some((child) => BLOCK_TAGS.has(child.tagName))

// Rich clipboard payloads should win over their text/plain fallback. In
// particular, WeChat articles contain numbered subheadings such as "1. ...";
// treating that fallback as Markdown discards the real headings and images.
export function hasStructuredWebHtml(html) {
  if (!html || !/<[a-z][\s\S]*>/i.test(html)) return false
  const template = document.createElement('template')
  template.innerHTML = html
  return !!template.content.querySelector(STRUCTURED_WEB_SELECTOR)
}

export function normalizeWebPasteHtml(html) {
  if (!html || !/<(?:section|div|img)(?:\s|>)/i.test(html)) return html

  const template = document.createElement('template')
  template.innerHTML = html

  // WeChat lazy-loads article images from data-src. The copied fragment can
  // retain data-src without a src, which ProseMirror then drops as an invalid
  // image. Promote the real URL before its DOM parser sees the fragment.
  template.content.querySelectorAll('img[data-src]').forEach((image) => {
    if (!image.getAttribute('src')) image.setAttribute('src', image.getAttribute('data-src'))
  })

  const wrappers = [...template.content.querySelectorAll('section, div')].reverse()

  wrappers.forEach((wrapper) => {
    if (!hasContent(wrapper) || hasDirectBlockChild(wrapper)) return
    const paragraph = document.createElement('p')
    for (const attribute of wrapper.attributes) {
      paragraph.setAttribute(attribute.name, attribute.value)
    }
    paragraph.append(...wrapper.childNodes)
    wrapper.replaceWith(paragraph)
  })

  return template.innerHTML
}
