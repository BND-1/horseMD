import katex from 'katex'
import { renderMermaidForExport } from './editor-mermaid.js'

const EXPORT_PREVIEW_DEADLINE_MS = 12000

const stripEditorOnlyForExport = (clone) => {
  clone
    .querySelectorAll(
      'button, select, .language-picker, .language-list, .tools, ' +
        '.tools-button-group, .button-group, .cm-panel, .cm-tooltip, ' +
        '.preview-panel, .cell-handle, .line-handle, .handle, .add-button, ' +
        '.operation, .operation-item, .drag-preview, .milkdown-block-handle, ' +
        '.milkdown-toolbar, .image-resize-handle, .label-wrapper, .hm-frontmatter-wrap, ' +
        '.hm-review-widget, .hm-review-card, .ProseMirror-separator, .ProseMirror-trailingBreak'
    )
    .forEach((el) => el.remove())
}

const cleanMathForExport = (math, { display } = {}) => {
  const copy = math.cloneNode(true)
  copy.querySelectorAll('annotation').forEach((node) => node.remove())
  ;[...copy.childNodes].forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) node.remove()
  })
  if (display) copy.setAttribute('display', 'block')
  return copy
}

const mathmlFromLatex = (doc, latex, { display } = {}) => {
  if (!latex) return null
  try {
    const tpl = doc.createElement('template')
    tpl.innerHTML = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: !!display,
      output: 'mathml'
    })
    const math = tpl.content.querySelector('math')
    return math ? cleanMathForExport(math, { display }) : null
  } catch {
    return null
  }
}

const codeBlockText = (block) => {
  const lines = [...block.querySelectorAll('.cm-line')].map((line) => line.textContent)
  if (lines.length) return lines.join('\n').replace(/\n+$/, '')
  return (block.textContent || '').replace(/^\s*LaTeX\s*/, '').replace(/\s*复制\s*/, '').trim()
}

const codeBlockLanguage = (block) => {
  const codeMirrorLanguage = block.querySelector('.cm-content')?.dataset?.language?.trim() || ''
  const pickerLanguage = block.querySelector('.language-button')?.textContent?.trim() || ''
  return (codeMirrorLanguage || pickerLanguage).toLowerCase()
}

const isLatexLanguage = (language) =>
  ['latex', 'tex', 'stex'].includes(language) || language.startsWith('latex')

const sanitizeGeneratedSvg = (svg) => {
  svg.querySelectorAll('script').forEach((node) => node.remove())
  svg.querySelectorAll('*').forEach((node) => {
    ;[...node.attributes].forEach((attribute) => {
      if (/^on/i.test(attribute.name) ||
          (/^(?:href|xlink:href)$/i.test(attribute.name) && /^\s*javascript:/i.test(attribute.value))) {
        node.removeAttribute(attribute.name)
      }
    })
  })
  const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number)
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    svg.setAttribute('width', String(viewBox[2]))
    svg.setAttribute('height', String(viewBox[3]))
  }
  svg.removeAttribute('style')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  return svg
}

const materializeLatexPreview = (block) => {
  const doc = block.ownerDocument
  const math = block.querySelector('.preview-panel math') ||
    mathmlFromLatex(doc, codeBlockText(block), { display: true })
  if (!math) return false
  const wrapper = doc.createElement('figure')
  wrapper.appendChild(math.tagName?.toLowerCase() === 'math'
    ? cleanMathForExport(math, { display: true })
    : math)
  block.replaceWith(wrapper)
  return true
}

const materializeMermaidPreview = (block, svgMarkup) => {
  if (!svgMarkup) return false
  const doc = block.ownerDocument
  const template = doc.createElement('template')
  template.innerHTML = svgMarkup
  const svg = template.content.querySelector('svg')
  if (!svg) return false
  const wrapper = doc.createElement('figure')
  wrapper.className = 'hm-pdf-diagram hm-pdf-mermaid'
  wrapper.setAttribute('data-hm-pdf-preserve', '')
  wrapper.appendChild(sanitizeGeneratedSvg(svg))
  block.replaceWith(wrapper)
  return true
}

const CODE_PREVIEW_EXPORTERS = [
  {
    matches: isLatexLanguage,
    materialize: (block) => materializeLatexPreview(block)
  },
  {
    matches: (language) => language === 'mermaid',
    materialize: (block, index, context) =>
      materializeMermaidPreview(block, context.mermaidPreviews.get(index))
  }
]

const materializeCodePreviewsForExport = (clone, mermaidPreviews) => {
  const blocks = [...clone.querySelectorAll('.milkdown-code-block')]
  blocks.forEach((block, index) => {
    const language = codeBlockLanguage(block)
    const exporter = CODE_PREVIEW_EXPORTERS.find((candidate) => candidate.matches(language))
    exporter?.materialize(block, index, { mermaidPreviews })
  })
}

const materializeTaskListsForExport = (clone) => {
  clone.querySelectorAll('li > .label-wrapper .label.checked, li > .label-wrapper .label.unchecked')
    .forEach((label) => {
      const item = label.closest('li')
      if (!item) return
      const checkbox = clone.ownerDocument.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.disabled = true
      if (label.classList.contains('checked')) {
        checkbox.checked = true
        checkbox.setAttribute('checked', '')
      }
      item.insertBefore(checkbox, item.firstChild)
    })
}

const materializeTableLayoutsForExport = (root, clone) => {
  const sourceTables = [...root.querySelectorAll('table')]
  const clonedTables = [...clone.querySelectorAll('table')]
  clonedTables.forEach((table, tableIndex) => {
    const source = sourceTables[tableIndex]
    const sourceRow = source?.rows?.[0]
    const cells = [...(sourceRow?.cells || [])]
    const tableRect = source?.getBoundingClientRect()
    const wrapper = source?.closest('.table-wrapper, .hm-html-block') || root
    const availableWidth = wrapper?.getBoundingClientRect?.().width || root.getBoundingClientRect().width
    if (
      !tableRect?.width ||
      cells.length < 2 ||
      cells.some((cell) => Number(cell.colSpan || 1) !== 1)
    ) {
      table.setAttribute('data-hm-pdf-table-layout', 'content')
      return
    }

    const widths = cells.map((cell) => cell.getBoundingClientRect().width)
    const total = widths.reduce((sum, width) => sum + width, 0)
    if (!total || widths.some((width) => !Number.isFinite(width) || width <= 0)) {
      table.setAttribute('data-hm-pdf-table-layout', 'content')
      return
    }

    let colgroup = table.querySelector(':scope > colgroup')
    if (!colgroup) {
      colgroup = clone.ownerDocument.createElement('colgroup')
      table.insertBefore(colgroup, table.querySelector(':scope > thead, :scope > tbody, :scope > tfoot, :scope > tr'))
    }
    while (colgroup.children.length < widths.length) {
      colgroup.appendChild(clone.ownerDocument.createElement('col'))
    }
    while (colgroup.children.length > widths.length) {
      colgroup.lastElementChild.remove()
    }
    ;[...colgroup.children].forEach((column, index) => {
      column.setAttribute('data-hm-pdf-column', '')
      column.style.width = `${Number((widths[index] / total * 100).toFixed(4))}%`
    })

    const isWide = Number.isFinite(availableWidth) && availableWidth > 0 &&
      tableRect.width > availableWidth + 1
    table.setAttribute('data-hm-pdf-table-layout', 'measured')
    if (isWide) table.setAttribute('data-hm-pdf-table-wide', 'true')
    table.removeAttribute('style')
    table.style.width = isWide ? '100%' : `${Math.ceil(tableRect.width)}px`
    table.style.maxWidth = '100%'
  })
}

const resolveMermaidPreviews = async (root) => {
  const previews = new Map()
  const blocks = [...root.querySelectorAll('.milkdown-code-block')]
  const deadline = Date.now() + EXPORT_PREVIEW_DEADLINE_MS
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (codeBlockLanguage(block) !== 'mermaid') continue
    const code = codeBlockText(block)
    if (!code.trim()) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const svg = await Promise.race([
      renderMermaidForExport(code, { theme: 'default' }),
      new Promise((resolve) => setTimeout(() => resolve(null), remaining))
    ])
    if (svg) previews.set(index, svg)
  }
  return previews
}

const replaceKatexWithMathml = (root) => {
  const doc = root.ownerDocument
  root.querySelectorAll('.katex-display').forEach((display) => {
    const math = display.querySelector('math')
    if (math) display.replaceWith(cleanMathForExport(math, { display: true }))
  })
  root.querySelectorAll('.katex').forEach((katex) => {
    const math = katex.querySelector('math')
    if (math) {
      katex.replaceWith(cleanMathForExport(math))
      return
    }
    const inline = katex.closest("span[data-type='math_inline']")
    const fallback = mathmlFromLatex(doc, inline?.dataset?.value || '', { display: false })
    if (fallback) katex.replaceWith(fallback)
  })
}

const flattenCodeMirrorBlocks = (clone) => {
  const doc = clone.ownerDocument
  clone.querySelectorAll('.cm-editor').forEach((cm) => {
    const lines = [...cm.querySelectorAll('.cm-line')].map((line) => line.textContent)
    const pre = doc.createElement('pre')
    const code = doc.createElement('code')
    code.textContent = (lines.length ? lines.join('\n') : cm.textContent).replace(/\n+$/, '')
    pre.appendChild(code)
    cm.replaceWith(pre)
  })
}

const stripEditorAttributes = (clone) => {
  clone.querySelectorAll('*').forEach((el) => {
    if (el.closest('[data-hm-pdf-preserve]')) return
    const measuredTable = el.closest('table[data-hm-pdf-table-layout="measured"]')
    const preserveTableStyle = measuredTable &&
      (el === measuredTable || (el.tagName === 'COL' && el.hasAttribute('data-hm-pdf-column')))
    el.removeAttribute('class')
    if (!preserveTableStyle) el.removeAttribute('style')
    el.removeAttribute('contenteditable')
    ;[...el.attributes].forEach((attribute) => {
      if (
        (attribute.name.startsWith('data-') && !attribute.name.startsWith('data-hm-pdf-')) ||
        attribute.name.startsWith('aria-')
      ) {
        el.removeAttribute(attribute.name)
      }
    })
  })
  clone.querySelectorAll('[data-hm-pdf-preserve]')
    .forEach((element) => element.removeAttribute('data-hm-pdf-preserve'))
}

export async function createPdfSourceFromEditor(root) {
  if (!root) return null
  const clone = root.cloneNode(true)
  const imageSources = [...root.querySelectorAll('img')].map((image) =>
    image.currentSrc || image.getAttribute('src') || ''
  )
  const mermaidPreviews = await resolveMermaidPreviews(clone)
  const images = []
  const clonedImages = [...clone.querySelectorAll('img')]
  clonedImages.forEach((image, index) => {
    const src = imageSources[index] || image.getAttribute('src') || ''
    image.removeAttribute('srcset')
    if (!src) {
      image.remove()
      return
    }
    if (/^data:/i.test(src)) return
    const placeholder = `horsemd-pdf-resource-${index + 1}`
    image.setAttribute('src', placeholder)
    images.push({ placeholder, src })
  })

  materializeCodePreviewsForExport(clone, mermaidPreviews)
  materializeTaskListsForExport(clone)
  materializeTableLayoutsForExport(root, clone)
  stripEditorOnlyForExport(clone)
  flattenCodeMirrorBlocks(clone)
  replaceKatexWithMathml(clone)
  stripEditorAttributes(clone)

  const headings = [...clone.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading, index) => {
    const id = `hm-pdf-heading-${index + 1}`
    heading.id = id
    return {
      id,
      level: Number(heading.tagName.slice(1)),
      text: heading.textContent?.trim() || ''
    }
  })
  return { html: clone.innerHTML, headings, images }
}
