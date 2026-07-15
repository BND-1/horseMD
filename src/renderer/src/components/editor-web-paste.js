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

const hasContent = (element) =>
  !!element.textContent?.trim() || !!element.querySelector('img, video, audio, br')

const hasDirectBlockChild = (element) =>
  [...element.children].some((child) => BLOCK_TAGS.has(child.tagName))

export function normalizeWebPasteHtml(html) {
  if (!html || !/<(?:section|div)(?:\s|>)/i.test(html)) return html

  const template = document.createElement('template')
  template.innerHTML = html
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
