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

const defaultLabels = {
  edit: 'Edit YAML',
  done: 'Done',
  input: 'YAML front matter'
}

// Build the visible card. Flat `key: value` lines → a definition grid; if there's
// any complex YAML (lists, nesting, multiline), fall back to a code box so we
// never misrender.
function buildCard(value, { editing = false, labels = defaultLabels, onToggle } = {}) {
  const card = document.createElement('div')
  card.className = 'hm-frontmatter'
  card.dataset.editing = editing ? 'true' : 'false'

  const head = document.createElement('div')
  head.className = 'hm-frontmatter-head'
  const title = document.createElement('span')
  title.className = 'hm-frontmatter-title'
  title.textContent = 'YAML'
  head.appendChild(title)
  if (onToggle) {
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'hm-frontmatter-action'
    action.textContent = editing ? labels.done : labels.edit
    action.title = editing ? labels.done : labels.edit
    action.addEventListener('click', onToggle)
    head.appendChild(action)
  }
  card.appendChild(head)

  if (editing) {
    const input = document.createElement('textarea')
    input.className = 'hm-frontmatter-input'
    input.value = value || ''
    input.spellcheck = false
    input.setAttribute('aria-label', labels.input)
    card.appendChild(input)
    return card
  }

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

// Update the atom attribute rather than attempting to make an atom node's DOM
// editable. This preserves the Markdown serializer contract while allowing the
// rendered card to edit YAML safely in rich mode.
export function updateFrontmatterValue(view, getPos, node, value) {
  const pos = getPos?.()
  if (!Number.isFinite(pos)) return false
  const current = view.state.doc.nodeAt(pos)
  if (!current || current.type !== node.type || current.attrs.value === value) return !!current
  view.dispatch(view.state.tr.setNodeMarkup(pos, current.type, { ...current.attrs, value }, current.marks))
  return true
}

// Node view: front matter remains an atom so its raw YAML always round-trips as
// one unit, but the card has an explicit edit state with a native textarea.
// Registered through nodeViewCtx so it composes with the other component views.
export function renderFrontmatterNodeView(node, view, getPos, {
  labels = defaultLabels,
  onEdit,
  onValueChange,
  canEdit = () => true
} = {}) {
  const dom = document.createElement('div')
  dom.className = 'hm-frontmatter-wrap'
  dom.setAttribute('data-type', 'frontmatter')
  dom.contentEditable = 'false'
  let currentNode = node
  let editing = false

  const render = ({ focus = false } = {}) => {
    dom.dataset.value = currentNode.attrs.value || ''
    dom.replaceChildren(buildCard(currentNode.attrs.value || '', {
      editing,
      labels,
      onToggle: canEdit() ? () => {
        editing = !editing
        render({ focus: editing })
      } : undefined
    }))
    const input = dom.querySelector('.hm-frontmatter-input')
    if (!input) return
    input.readOnly = !canEdit()
    input.addEventListener('input', () => {
      if (!canEdit()) return
      // markdownUpdated runs synchronously with the ProseMirror transaction,
      // before this DOM input event reaches the editor-root capture listener.
      // Mark intent first so the normal editor change pipeline commits the
      // canonical Markdown to App/source/save state.
      onEdit?.()
      if (updateFrontmatterValue(view, getPos, currentNode, input.value)) {
        onValueChange?.({ view, getPos })
      }
    })
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      editing = false
      render()
      view.focus()
    })
    if (focus) requestAnimationFrame(() => input.focus())
  }

  render()
  return {
    dom,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) return false
      currentNode = nextNode
      // Keep a focused textarea stable while its own input transaction reaches
      // ProseMirror; rebuilding it here would lose caret position on every key.
      if (!editing) render()
      return true
    },
    ignoreMutation: () => true,
    stopEvent: (event) => event.target instanceof Element && !!event.target.closest('button, textarea')
  }
}
