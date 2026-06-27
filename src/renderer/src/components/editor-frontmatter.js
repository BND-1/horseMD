// YAML front matter support (the `---` block at the top of a document, as in
// SKILL.md / Hugo / Jekyll). Milkdown doesn't recognize it by default, so it
// rendered as a horizontal rule + Setext headings. With `remark-frontmatter` the
// block parses to a `yaml` mdast node; this module adds a Milkdown block node for
// it that renders a structured key/value card (flat `key: value` → a definition
// grid; anything nested → a code box), and round-trips back to `---\n…\n---`.
import { $nodeSchema } from '@milkdown/utils'

export const frontmatterSchema = $nodeSchema('frontmatter', () => ({
  group: 'block',
  atom: true,
  isolating: true,
  defining: true,
  attrs: {
    value: { default: '' }
  },
  parseDOM: [
    {
      tag: 'div[data-type="frontmatter"]',
      getAttrs: (dom) => ({ value: dom.dataset.value || '' })
    }
  ],
  toDOM: (node) => {
    const card = buildCard(node.attrs.value || '')
    return ['div', { 'data-type': 'frontmatter', 'data-value': node.attrs.value || '' }, card]
  },
  parseMarkdown: {
    match: (node) => node.type === 'yaml',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value || '' })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'frontmatter',
    runner: (state, node) => {
      // remark-frontmatter serializes a `yaml` node back to a `---` block.
      state.addNode('yaml', undefined, node.attrs.value || '')
    }
  }
}))

// Build the visible card. Flat `key: value` lines → a definition grid; if there's
// any complex YAML (lists, nesting, multiline), fall back to a code box so we
// never misrender.
function buildCard(value) {
  const card = document.createElement('div')
  card.className = 'hm-frontmatter'

  const head = document.createElement('div')
  head.className = 'hm-frontmatter-head'
  head.textContent = 'YAML'
  card.appendChild(head)

  const lines = (value || '').split('\n')
  // "simple" = every non-blank line is a flat `key: value` (no indentation,
  // list markers, quotes-only, etc.).
  const simple = lines.every(
    (l) => l.trim() === '' || /^[A-Za-z0-9_.-]+:\s?.*$/.test(l)
  )
  if (simple) {
    const grid = document.createElement('dl')
    grid.className = 'hm-frontmatter-grid'
    for (const line of lines) {
      const m = line.match(/^([A-Za-z0-9_.-]+):\s?(.*)$/)
      if (!m) continue
      const dt = document.createElement('dt')
      dt.textContent = m[1]
      const dd = document.createElement('dd')
      dd.textContent = m[2]
      grid.appendChild(dt)
      grid.appendChild(dd)
    }
    if (grid.children.length) card.appendChild(grid)
    else card.appendChild(rawBlock(value))
  } else {
    card.appendChild(rawBlock(value))
  }
  return card
}

const rawBlock = (value) => {
  const pre = document.createElement('pre')
  pre.className = 'hm-frontmatter-raw'
  pre.textContent = value || ''
  return pre
}

// Node view: render the card, display-only (contentEditable false). Registered
// through nodeViewCtx (the same channel Milkdown's $view uses) so it composes
// with the other component node views.
export function renderFrontmatterNodeView(node) {
  const dom = document.createElement('div')
  dom.className = 'hm-frontmatter-wrap'
  dom.setAttribute('data-type', 'frontmatter')
  dom.setAttribute('data-value', node.attrs.value || '')
  dom.contentEditable = 'false'
  dom.appendChild(buildCard(node.attrs.value || ''))
  return { dom, ignoreMutation: () => true, stopEvent: () => false }
}
